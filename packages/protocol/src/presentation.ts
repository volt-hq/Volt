/**
 * Presentations (RFC §4.3, §8.3): how a tool call or a custom message looks,
 * as `UiNode` data. Tools and custom message types register pure, synchronous
 * `present()` functions on the host, so clients never run extension code; a
 * call or message without a registered presenter gets the generic
 * presentation. Clients draw the generic chrome around a presentation: the
 * call's state, its elapsed time, and collapsing between `summary` and `body`.
 */

import { type Static, Type } from "typebox";
import { UiNodeActionSchema, UiNodeSchema, UiNodeStyledTextSchema } from "./ui-node.ts";
import { UiPatchSchema } from "./ui-patch.ts";

const closed = { additionalProperties: false } as const;

/** Largest presentation a host sends a local client, as serialized JSON in UTF-8 bytes. */
export const PRESENTATION_MAX_SERIALIZED_BYTES = 64 * 1024;
/** Largest presentation a host sends a remote client, as serialized JSON in UTF-8 bytes. */
export const PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES = 16 * 1024;
/** Largest extension panel node, as serialized JSON in UTF-8 bytes. */
export const PANEL_MAX_SERIALIZED_BYTES = 32 * 1024;

/** The `x-volt-limits` block for presentations and panels. */
export const PRESENTATION_LIMITS = {
	maxSerializedBytes: PRESENTATION_MAX_SERIALIZED_BYTES,
	remoteMaxSerializedBytes: PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
	panelMaxSerializedBytes: PANEL_MAX_SERIALIZED_BYTES,
} as const;

/** How one tool call looks: what its `present()` returned for its arguments, state, and result. */
export const ToolPresentationSchema = Type.Object(
	{
		/** One line naming the call, such as `$ npm test`. */
		title: UiNodeStyledTextSchema,
		/** What the call is doing while it runs. */
		activity: Type.Optional(UiNodeStyledTextSchema),
		/** Shown while the call is collapsed. */
		summary: Type.Optional(Type.Array(UiNodeSchema)),
		/** Shown while the call is expanded. */
		body: Type.Optional(Type.Array(UiNodeSchema)),
		actions: Type.Optional(Type.Array(UiNodeActionSchema)),
		/** Clients do not show the call. */
		hidden: Type.Optional(Type.Boolean()),
		/** Clients show the call's elapsed time. */
		showsDuration: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type ToolPresentation = Static<typeof ToolPresentationSchema>;

/**
 * An update to the presentation a client holds for a tool call: the patches
 * apply to its `summary` and `body` trees (an absent one is the empty tree;
 * an emptied one is absent again). Every other field is unchanged.
 */
export const ToolPresentationPatchSchema = Type.Object(
	{ summary: Type.Optional(UiPatchSchema), body: Type.Optional(UiPatchSchema) },
	{ ...closed, minProperties: 1 },
);
export type ToolPresentationPatch = Static<typeof ToolPresentationPatchSchema>;

/** How one custom message looks: what its type's message presenter returned. */
export const MessagePresentationSchema = Type.Object(
	{
		title: Type.Optional(UiNodeStyledTextSchema),
		/** Shown while the message is collapsed. */
		summary: Type.Optional(Type.Array(UiNodeSchema)),
		body: Type.Array(UiNodeSchema),
	},
	closed,
);
export type MessagePresentation = Static<typeof MessagePresentationSchema>;
