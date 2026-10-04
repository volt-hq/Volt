/**
 * Push notification intents relayed from a TUI-served phone conversation to
 * the daemon, which owns push delivery, and the delivery outcome it reports.
 *
 * An intent on the wire is already canonical: hosts sanitize lock-screen text
 * before sending, and the daemon rejects anything a sanitizer would rewrite.
 * The patterns encode that canonical form; the UTF-8 budgets are
 * `x-volt-max-utf8-bytes` annotations enforced by a layered check, because
 * JSON Schema `maxLength` does not count bytes.
 */

import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";

export const MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES = 128;
export const MAX_IROH_REMOTE_NOTIFICATION_BODY_UTF8_BYTES = 512;
export const MAX_IROH_REMOTE_NOTIFICATION_WORKSPACE_UTF8_BYTES = 128;
export const MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES = 128;
export const MAX_IROH_REMOTE_NOTIFICATION_EVENT_ID_UTF8_BYTES = 512;

export const IROH_REMOTE_NOTIFICATION_KINDS = [
	"conversation_completed",
	"plan_ready",
	"review_completed",
	"action_completed",
	"host_notice",
] as const;

/** A character allowed anywhere in notification text: no whitespace, path separator, control, format, or surrogate code point. */
const NOTIFICATION_CHARACTER = String.raw`[^\s/\\\p{Cc}\p{Cf}\p{Cs}]`;

/**
 * Lock-screen text: words separated by single spaces, no leading or trailing
 * whitespace. `maxLength` (the byte budget, never below the character count)
 * rejects most oversized input before the pattern runs; it counts grapheme
 * clusters, so the layered byte check is what bounds the size.
 */
const notificationText = (maxBytes: number) =>
	Type.String({
		maxLength: maxBytes,
		pattern: `^${NOTIFICATION_CHARACTER}+(?: ${NOTIFICATION_CHARACTER}+)*$`,
		"x-volt-max-utf8-bytes": maxBytes,
	});

/** An opaque identifier: one whitespace-free token. */
const notificationMetadata = (maxBytes: number) =>
	Type.String({ maxLength: maxBytes, pattern: `^${NOTIFICATION_CHARACTER}+$`, "x-volt-max-utf8-bytes": maxBytes });

const notificationProperties = {
	eventId: notificationMetadata(MAX_IROH_REMOTE_NOTIFICATION_EVENT_ID_UTF8_BYTES),
	hostNodeId: Type.String({ pattern: "^[0-9a-f]{64}$" }),
	title: notificationText(MAX_IROH_REMOTE_NOTIFICATION_TITLE_UTF8_BYTES),
	body: notificationText(MAX_IROH_REMOTE_NOTIFICATION_BODY_UTF8_BYTES),
	sessionId: Type.Optional(notificationMetadata(MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES)),
	workspaceName: Type.Optional(notificationText(MAX_IROH_REMOTE_NOTIFICATION_WORKSPACE_UTF8_BYTES)),
};

/** `plan_ready` names its plan, `review_completed` its workflow; every other kind carries neither. */
export const IrohRemotePushNotificationSchema = Type.Union([
	Type.Object(
		{
			...notificationProperties,
			kind: stringEnum(["conversation_completed", "action_completed", "host_notice"]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...notificationProperties,
			kind: Type.Literal("plan_ready"),
			planId: notificationMetadata(MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...notificationProperties,
			kind: Type.Literal("review_completed"),
			workflowId: notificationMetadata(MAX_IROH_REMOTE_NOTIFICATION_METADATA_UTF8_BYTES),
		},
		{ additionalProperties: false },
	),
]);
export type IrohRemotePushNotification = Static<typeof IrohRemotePushNotificationSchema>;

export const IrohRemotePushNotificationDeliveryStatusSchema = stringEnum([
	"sent",
	"no_push_target",
	"duplicate",
	"failed",
	"invalid_target",
]);
export type IrohRemotePushNotificationDeliveryStatus = Static<typeof IrohRemotePushNotificationDeliveryStatusSchema>;
