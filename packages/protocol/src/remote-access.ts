/**
 * Remote access: the capability vocabulary granted to a paired device, the
 * grant record the host stores and reports, and the named access presets.
 * The daemon control plane and the relay preamble carry these shapes.
 */

import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RPC_WIRE_MAX_SAFE_INTEGER } from "./wire-limits.ts";

export const IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION = 1 as const;

export const IROH_REMOTE_RPC_CAPABILITIES = [
	"conversation.observe.v1",
	"conversation.control.v1",
	"model.select.v1",
	"integrations.manage.v1",
	"worktrees.manage.v1",
	"host.manage.v1",
	"workspace.manage.v1",
	"diagnostics.upload.v1",
] as const;

export const IROH_REMOTE_ACCESS_PRESET_NAMES = ["coding", "review", "chat", "full"] as const;

export const IrohRemoteRpcCapabilitySchema = stringEnum(IROH_REMOTE_RPC_CAPABILITIES, {
	"x-volt-expected": "be a known remote capability",
});
export type IrohRemoteRpcCapability = Static<typeof IrohRemoteRpcCapabilitySchema>;

/** A capability set: every entry known, none repeated. */
export const IrohRemoteRpcCapabilitiesSchema = Type.Array(IrohRemoteRpcCapabilitySchema, {
	maxItems: IROH_REMOTE_RPC_CAPABILITIES.length,
	uniqueItems: true,
});

/** A device's RPC grant. `revision` increases on every access change and fences concurrent edits. */
export const IrohRemoteRpcGrantSchema = Type.Object(
	{
		schemaVersion: Type.Literal(IROH_REMOTE_RPC_GRANT_SCHEMA_VERSION),
		revision: Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER }),
		capabilities: IrohRemoteRpcCapabilitiesSchema,
	},
	{ additionalProperties: false },
);
export type IrohRemoteRpcGrant = Static<typeof IrohRemoteRpcGrantSchema>;

export const IrohRemoteAccessPresetNameSchema = stringEnum(IROH_REMOTE_ACCESS_PRESET_NAMES);
export type IrohRemoteAccessPresetName = Static<typeof IrohRemoteAccessPresetNameSchema>;
