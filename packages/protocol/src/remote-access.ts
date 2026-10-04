/**
 * Remote access: the capabilities a paired device can hold, the grant that
 * stores them, and the named access presets (RFC §6.2: capability grants
 * collapse into profile definitions).
 *
 * A remote client's grant is re-read for every frame; an intent or query whose
 * descriptor `requires` a capability the grant lacks is rejected with
 * `not_allowed{requiredCapability}`. Stored grants keep this exact shape.
 */

import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RPC_WIRE_MAX_SAFE_INTEGER } from "./wire-limits.ts";

/** Every capability a remote grant can hold. */
export const REMOTE_CAPABILITIES = [
	"conversation.observe.v1",
	"conversation.control.v1",
	"model.select.v1",
	"integrations.manage.v1",
	"worktrees.manage.v1",
	"host.manage.v1",
	"workspace.manage.v1",
	"diagnostics.upload.v1",
] as const;

export const RemoteCapabilitySchema = stringEnum(REMOTE_CAPABILITIES);
export type RemoteCapability = Static<typeof RemoteCapabilitySchema>;

/** A set of capabilities: no duplicates, so never more entries than there are capabilities. */
export const RemoteCapabilitiesSchema = Type.Array(RemoteCapabilitySchema, {
	maxItems: REMOTE_CAPABILITIES.length,
	uniqueItems: true,
});

export const REMOTE_GRANT_SCHEMA_VERSION = 1;

/** A device's stored capability grant. `revision` increases on every change, so a stale grant is detectable. */
export const RemoteGrantSchema = Type.Object(
	{
		schemaVersion: Type.Literal(REMOTE_GRANT_SCHEMA_VERSION),
		revision: Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER }),
		capabilities: RemoteCapabilitiesSchema,
	},
	{ additionalProperties: false },
);
export type RemoteGrant = Static<typeof RemoteGrantSchema>;

export const REMOTE_ACCESS_PRESET_NAMES = ["coding", "review", "chat", "full"] as const;

export const RemoteAccessPresetNameSchema = stringEnum(REMOTE_ACCESS_PRESET_NAMES);
export type RemoteAccessPresetName = Static<typeof RemoteAccessPresetNameSchema>;

/**
 * The capabilities a paired device holds out of the box: it is the user's own,
 * so host-request approvals and keep-awake work without a custom grant.
 */
const STANDARD_CAPABILITIES: readonly RemoteCapability[] = Object.freeze([
	"conversation.observe.v1",
	"conversation.control.v1",
	"model.select.v1",
	"host.manage.v1",
]);

/** The capabilities each preset grants. Presets differ otherwise only in the tools they allow, which the host owns. */
export const REMOTE_ACCESS_PRESET_CAPABILITIES: Readonly<Record<RemoteAccessPresetName, readonly RemoteCapability[]>> =
	Object.freeze({
		coding: STANDARD_CAPABILITIES,
		review: STANDARD_CAPABILITIES,
		chat: STANDARD_CAPABILITIES,
		full: Object.freeze([...REMOTE_CAPABILITIES]),
	});
