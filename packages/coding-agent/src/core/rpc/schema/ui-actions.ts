/**
 * Native UI action contract schemas. The `(string & {})` open unions of the
 * hand-written types map to `openStringEnum` — known values are documentation
 * in the artifact, never a validation constraint.
 */

import { Type } from "typebox";
import { openStringEnum, stringEnum } from "./helpers.ts";

const UI_ACTION_SOURCES = ["builtin", "extension", "prompt", "skill", "package"] as const;
const UI_ACTION_CATEGORIES = [
	"review",
	"session",
	"model",
	"context",
	"extension",
	"prompt",
	"skill",
	"advanced",
] as const;
const UI_ACTION_PRESENTATION_KINDS = ["card", "button", "toggle", "picker", "palette", "detail", "hidden"] as const;
const UI_ACTION_ARGUMENT_TYPES = ["string", "boolean", "enum", "integer"] as const;
const UI_ACTION_STATE_TYPES = ["boolean", "string", "enum", "integer"] as const;
const UI_ACTION_STREAMING_BEHAVIORS = ["disabled", "immediate", "queueSteer", "queueFollowUp"] as const;

export const UiActionSourceSchema = stringEnum(UI_ACTION_SOURCES);
export const UiActionCategorySchema = stringEnum(UI_ACTION_CATEGORIES);
export const UiActionPresentationKindSchema = stringEnum(UI_ACTION_PRESENTATION_KINDS);
export const UiActionArgumentTypeSchema = stringEnum(UI_ACTION_ARGUMENT_TYPES);
export const UiActionStateTypeSchema = stringEnum(UI_ACTION_STATE_TYPES);
export const UiActionStreamingBehaviorSchema = stringEnum(UI_ACTION_STREAMING_BEHAVIORS);
export const UiActionScalarSchema = Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
export const UiActionInvocationQueueBehaviorSchema = stringEnum(["steer", "followUp"]);
export const UiActionInvocationStatusSchema = stringEnum(["accepted", "completed", "queued", "handled", "cancelled"]);
export const UiActionCapabilityFeatureSchema = openStringEnum([
	"ui_actions.v1",
	"ui_action_invocation.v1",
	"ui_action_completions.v1",
]);

export const UiActionOptionDescriptorSchema = Type.Object(
	{
		value: Type.String(),
		label: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const UiActionPresentationHintSchema = Type.Object(
	{
		kind: openStringEnum(UI_ACTION_PRESENTATION_KINDS),
		group: Type.Optional(Type.String()),
		priority: Type.Optional(Type.Number()),
		icon: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const UiActionArgumentDescriptorSchema = Type.Object(
	{
		name: Type.String(),
		label: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		type: openStringEnum(UI_ACTION_ARGUMENT_TYPES),
		required: Type.Optional(Type.Boolean()),
		multiline: Type.Optional(Type.Boolean()),
		placeholder: Type.Optional(Type.String()),
		hint: Type.Optional(Type.String()),
		defaultValue: Type.Optional(UiActionScalarSchema),
		options: Type.Optional(Type.Array(UiActionOptionDescriptorSchema)),
		completion: Type.Optional(openStringEnum(["commandArguments"])),
	},
	{ additionalProperties: false },
);

export const UiActionStateDescriptorSchema = Type.Object(
	{
		type: openStringEnum(UI_ACTION_STATE_TYPES),
		value: UiActionScalarSchema,
		label: Type.Optional(Type.String()),
		options: Type.Optional(Type.Array(UiActionOptionDescriptorSchema)),
	},
	{ additionalProperties: false },
);

export const UiActionSlashAliasSchema = Type.Object(
	{
		name: Type.String(),
		example: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const UiActionDescriptorSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		id: Type.String(),
		label: Type.String(),
		description: Type.Optional(Type.String()),
		source: openStringEnum(UI_ACTION_SOURCES),
		sourceScope: Type.Optional(stringEnum(["user", "project", "temporary"])),
		sourceOrigin: Type.Optional(stringEnum(["package", "top-level"])),
		sourceLabel: Type.Optional(Type.String()),
		category: openStringEnum(UI_ACTION_CATEGORIES),
		presentation: Type.Optional(UiActionPresentationHintSchema),
		args: Type.Optional(Type.Array(UiActionArgumentDescriptorSchema)),
		state: Type.Optional(UiActionStateDescriptorSchema),
		enabled: Type.Boolean(),
		disabledReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		destructive: Type.Optional(Type.Boolean()),
		requiresConfirmation: Type.Optional(Type.Boolean()),
		streamingBehavior: Type.Optional(
			Type.Union([UiActionStreamingBehaviorSchema, Type.Array(UiActionStreamingBehaviorSchema)]),
		),
		remoteSafe: Type.Boolean(),
		slash: Type.Optional(UiActionSlashAliasSchema),
	},
	{ additionalProperties: false },
);

export const UiActionCapabilitiesSchema = Type.Object(
	{
		protocolVersion: Type.Literal(1),
		features: Type.Array(UiActionCapabilityFeatureSchema),
		maxActions: Type.Number(),
		maxDescriptorBytes: Type.Number(),
	},
	{ additionalProperties: false },
);

export const UiActionListResponseSchema = Type.Object(
	{ actions: Type.Array(UiActionDescriptorSchema) },
	{ additionalProperties: false },
);

export const UiActionCompletionListResponseSchema = Type.Object(
	{ completions: Type.Array(UiActionOptionDescriptorSchema) },
	{ additionalProperties: false },
);

export const UiActionInvocationResponseSchema = Type.Object(
	{
		action: Type.String(),
		status: UiActionInvocationStatusSchema,
		queuedAs: Type.Optional(UiActionInvocationQueueBehaviorSchema),
		/** Detached workflow started by this invocation (review actions). */
		workflowId: Type.Optional(Type.String()),
		state: Type.Optional(UiActionStateDescriptorSchema),
		stateChanged: Type.Optional(Type.Boolean()),
		actionsChanged: Type.Optional(Type.Boolean()),
		message: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
