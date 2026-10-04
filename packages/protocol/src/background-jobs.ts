import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RpcConversationIdentifierSchema } from "./primitives.ts";

/** Session-owned job metadata. Output is available only through the `job_output` query. */
export const RpcBackgroundJobSummarySchema = Type.Object(
	{
		id: RpcConversationIdentifierSchema,
		toolName: stringEnum(["bash", "subagent"]),
		/** Omitted if the originating provider's tool-call identity exceeds the wire bound. */
		toolCallId: Type.Optional(RpcConversationIdentifierSchema),
		label: Type.String({ maxLength: 200 }),
		status: stringEnum(["running", "cancelling", "completed", "failed", "cancelled"]),
		startedAt: Type.Number(),
		endedAt: Type.Optional(Type.Number()),
		lastOutputAt: Type.Optional(Type.Number()),
		outputTruncated: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export type RpcBackgroundJobSummary = Static<typeof RpcBackgroundJobSummarySchema>;

export const RpcBackgroundJobsSchema = Type.Array(RpcBackgroundJobSummarySchema, { maxItems: 64 });

export const RpcBackgroundJobSnapshotSchema = Type.Object(
	{
		...RpcBackgroundJobSummarySchema.properties,
		/** Latest non-destructive tail, at most 50 KiB UTF-8 or 2000 lines before remote path sanitization. */
		output: Type.String(),
	},
	{ additionalProperties: false },
);
export type RpcBackgroundJobSnapshot = Static<typeof RpcBackgroundJobSnapshotSchema>;
