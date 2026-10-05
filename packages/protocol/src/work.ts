/**
 * The work vocabulary (RFC §7): kinds, lifecycle states, outcomes, delivery
 * policies, progress, the bounds of work entries, and the notice a delivered
 * result queues.
 *
 * Long-running work is recorded in the conversation log as three core host
 * entries (`work_started`, `work_checkpoint`, `work_finished`, defined in
 * entries.ts). Open work is `awaiting_approval`, `running`, or `cancelling`;
 * it ends with one outcome. A kind's delivery policy and resumability are
 * copied into `work_started`, so the kernel reconciles open work from the
 * log alone.
 *
 * Light module: the session-store worker loads it through the
 * `@hansjm10/volt-protocol/work` subpath, so it imports only typebox and light
 * protocol modules.
 */

import { type Static, Type } from "typebox";
import type { WorkCheckpointEntryPayload, WorkFinishedEntryPayload, WorkStartedEntryPayload } from "./entries.ts";
import { RESERVED_EXTENSION_IDS } from "./extensions.ts";
import { stringEnum } from "./helpers.ts";
import { UI_NODE_LINE_PATTERN, UI_NODE_TEXT_PATTERN, UiNodeKeySchema, UiNodeTextSchema } from "./ui-node.ts";

const closed = { additionalProperties: false } as const;

// ============================================================================
// Limits
// ============================================================================

/** Longest work title, in characters. */
export const WORK_TITLE_MAX_CHARS = 200;
/** Longest result summary or error, in characters. */
export const WORK_TEXT_MAX_CHARS = 2_000;
/** Largest `work_started` input, as serialized JSON in UTF-8 bytes. */
export const WORK_INPUT_MAX_SERIALIZED_BYTES = 16 * 1024;
/** Largest `work_checkpoint` payload, as serialized JSON in UTF-8 bytes. Checkpoints are coarse. */
export const WORK_CHECKPOINT_MAX_SERIALIZED_BYTES = 8 * 1024;
/** Largest output tail a result keeps, in UTF-8 bytes; older output is dropped and `truncated` set. */
export const WORK_OUTPUT_MAX_UTF8_BYTES = 50 * 1024;
/** Largest kind-specific result data, as serialized JSON in UTF-8 bytes. */
export const WORK_DATA_MAX_SERIALIZED_BYTES = 64 * 1024;

/** The `x-volt-limits` block for work entries. */
export const WORK_LIMITS = {
	titleMaxChars: WORK_TITLE_MAX_CHARS,
	textMaxChars: WORK_TEXT_MAX_CHARS,
	inputMaxSerializedBytes: WORK_INPUT_MAX_SERIALIZED_BYTES,
	checkpointMaxSerializedBytes: WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	outputMaxUtf8Bytes: WORK_OUTPUT_MAX_UTF8_BYTES,
	dataMaxSerializedBytes: WORK_DATA_MAX_SERIALIZED_BYTES,
} as const;

// ============================================================================
// Vocabulary
// ============================================================================

/** The kinds a host defines itself. */
export const BUILTIN_WORK_KINDS = ["job", "subagent", "review", "host_action"] as const;

/**
 * An extension's kind: `ext:<extension id>/<kind name>`. The id is a manifest
 * id (`EXTENSION_ID_PATTERN`), so never a reserved one.
 */
export const EXTENSION_WORK_KIND_PATTERN = `^ext:(?!(?:${RESERVED_EXTENSION_IDS.join("|")})/)[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9_-]{0,63}$`;

export type ExtensionWorkKind = `ext:${string}/${string}`;

export const WorkKindSchema = Type.Union(
	[
		stringEnum(BUILTIN_WORK_KINDS),
		Type.Unsafe<ExtensionWorkKind>(Type.String({ pattern: EXTENSION_WORK_KIND_PATTERN })),
	],
	{ "x-volt-expected": "be a built-in work kind or ext:<extension>/<kind>" },
);
export type WorkKind = Static<typeof WorkKindSchema>;

/**
 * Open work: `awaiting_approval` before an approval lets it run, `running`, or
 * `cancelling` once cancellation was requested. `awaiting_approval` moves to
 * `running` or `cancelling`, `running` to `cancelling`; nothing moves back.
 */
export const WorkStateSchema = stringEnum(["awaiting_approval", "running", "cancelling"]);
export type WorkState = Static<typeof WorkStateSchema>;

/** How work ended. `interrupted` work lost its executor (the runtime ended) and was not resumed. */
export const WorkOutcomeSchema = stringEnum(["completed", "failed", "cancelled", "interrupted"]);
export type WorkOutcome = Static<typeof WorkOutcomeSchema>;

/**
 * What a completed or failed result does: `none`; `message` queues a notice
 * the model sees with its next turn; `wake` queues the notice and starts a
 * turn when the conversation is idle.
 */
export const WorkDeliverySchema = stringEnum(["none", "message", "wake"]);
export type WorkDelivery = Static<typeof WorkDeliverySchema>;

/** Plain text a client renders: no terminal control sequences, at most {@link WORK_TEXT_MAX_CHARS}. */
export const WorkTextSchema = Type.String({
	maxLength: WORK_TEXT_MAX_CHARS,
	pattern: UI_NODE_TEXT_PATTERN,
	"x-volt-expected": "be text without terminal control sequences",
});

/** One line naming the work in lists and notices. */
export const WorkTitleSchema = Type.String({
	minLength: 1,
	maxLength: WORK_TITLE_MAX_CHARS,
	pattern: UI_NODE_LINE_PATTERN,
	"x-volt-expected": "be one non-empty line without terminal control sequences",
});

export const WorkProgressStepSchema = Type.Object(
	{
		key: UiNodeKeySchema,
		label: UiNodeTextSchema,
		status: stringEnum(["pending", "active", "done", "failed", "skipped"]),
	},
	closed,
);
export type WorkProgressStep = Static<typeof WorkProgressStepSchema>;

/** Coarse progress: text, a determinate `value` of `max` (default 1), or steps. */
export const WorkProgressSchema = Type.Object(
	{
		text: Type.Optional(UiNodeTextSchema),
		value: Type.Optional(Type.Number({ minimum: 0 })),
		max: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		steps: Type.Optional(Type.Array(WorkProgressStepSchema)),
	},
	closed,
);
export type WorkProgress = Static<typeof WorkProgressSchema>;

/** The custom type of the custom message a delivered result queues. Its details are `WorkNoticeDetails`. */
export const WORK_NOTICE_CUSTOM_TYPE = "work_notice";

// ============================================================================
// Bounds
// ============================================================================

const encoder = new TextEncoder();

function serializedBytes(value: unknown): number | undefined {
	const json = JSON.stringify(value);
	return json === undefined ? undefined : encoder.encode(json).byteLength;
}

/** A work entry as its type and payload. */
export type WorkEntryPayload =
	| { readonly type: "work_started"; readonly payload: WorkStartedEntryPayload }
	| { readonly type: "work_checkpoint"; readonly payload: WorkCheckpointEntryPayload }
	| { readonly type: "work_finished"; readonly payload: WorkFinishedEntryPayload };

/**
 * The byte bound a schema-valid work payload exceeds, or undefined when it is
 * within bounds. JSON Schema cannot express byte budgets, so writers check
 * them after schema validation.
 */
export function workPayloadBoundsError(entry: WorkEntryPayload): string | undefined {
	switch (entry.type) {
		case "work_started": {
			const bytes = serializedBytes(entry.payload.input);
			if (bytes === undefined) return "work input must be JSON data";
			return bytes > WORK_INPUT_MAX_SERIALIZED_BYTES
				? `work input exceeds ${WORK_INPUT_MAX_SERIALIZED_BYTES} serialized bytes`
				: undefined;
		}
		case "work_checkpoint":
			return (serializedBytes(entry.payload) ?? 0) > WORK_CHECKPOINT_MAX_SERIALIZED_BYTES
				? `work checkpoint exceeds ${WORK_CHECKPOINT_MAX_SERIALIZED_BYTES} serialized bytes`
				: undefined;
		case "work_finished": {
			const { output, data } = entry.payload.result ?? {};
			if (output && encoder.encode(output.text).byteLength > WORK_OUTPUT_MAX_UTF8_BYTES) {
				return `work output exceeds ${WORK_OUTPUT_MAX_UTF8_BYTES} UTF-8 bytes`;
			}
			if (data === undefined) return undefined;
			const bytes = serializedBytes(data);
			if (bytes === undefined) return "work result data must be JSON data";
			return bytes > WORK_DATA_MAX_SERIALIZED_BYTES
				? `work result data exceeds ${WORK_DATA_MAX_SERIALIZED_BYTES} serialized bytes`
				: undefined;
		}
	}
}
