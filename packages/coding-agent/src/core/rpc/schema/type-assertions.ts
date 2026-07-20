/**
 * Compile-time drift tripwires for the RPC contract schemas. No runtime
 * exports — `tsgo --noEmit` (and every build) fails when a schema's `Static`
 * type and its hand-written or upstream counterpart disagree.
 */

import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { ImageContent } from "@hansjm10/volt-ai";
import type { Static } from "typebox";
import type {
	RpcAssistantStreamPosition,
	RpcClientCapabilityFeature,
	RpcCommand,
	RpcCommandType,
	RpcConversationAuthority,
	RpcConversationDiscontinuityReason,
	RpcLiveActivityRegistration,
	RpcRegisterPushTargetArgs,
} from "../types.ts";
import type { RPC_COMMAND_SCHEMAS, RpcClientCapabilityFeatureSchema } from "./commands.ts";
import type { Assert, MutualExtends } from "./helpers.ts";
import type {
	RpcAssistantStreamPositionSchema,
	RpcConversationAuthoritySchema,
	RpcConversationDiscontinuityReasonSchema,
	RpcImageContentSchema,
	RpcLiveActivityRegistrationSchema,
	RpcRegisterPushTargetArgsSchema,
	RpcThinkingLevelSchema,
} from "./primitives.ts";

// Every command schema's Static type must match its member of the RpcCommand
// union, key by key. On failure, inspect `DriftedCommands` — it resolves to
// the union of command names whose schema and type disagree.
type CommandStatics = { [K in RpcCommandType]: Static<(typeof RPC_COMMAND_SCHEMAS)[K]> };
type CommandMembers = { [K in RpcCommandType]: Extract<RpcCommand, { type: K }> };
type DriftedCommands = {
	[K in RpcCommandType]: MutualExtends<CommandStatics[K], CommandMembers[K]> extends true ? never : K;
}[RpcCommandType];
type _commands = Assert<[DriftedCommands] extends [never] ? true : DriftedCommands>;

// Wire projections of upstream types: if volt-ai / volt-agent-core change
// these shapes, the contract must change consciously, not silently.
type _imageContent = Assert<MutualExtends<Static<typeof RpcImageContentSchema>, ImageContent>>;
type _thinkingLevel = Assert<MutualExtends<Static<typeof RpcThinkingLevelSchema>, ThinkingLevel>>;

// Shared leaf schemas pinned to their exported contract types.
type _authority = Assert<MutualExtends<Static<typeof RpcConversationAuthoritySchema>, RpcConversationAuthority>>;
type _position = Assert<MutualExtends<Static<typeof RpcAssistantStreamPositionSchema>, RpcAssistantStreamPosition>>;
type _discontinuityReason = Assert<
	MutualExtends<Static<typeof RpcConversationDiscontinuityReasonSchema>, RpcConversationDiscontinuityReason>
>;
type _clientCapabilityFeature = Assert<
	MutualExtends<Static<typeof RpcClientCapabilityFeatureSchema>, RpcClientCapabilityFeature>
>;
type _pushTargetArgs = Assert<MutualExtends<Static<typeof RpcRegisterPushTargetArgsSchema>, RpcRegisterPushTargetArgs>>;
type _liveActivityRegistration = Assert<
	MutualExtends<Static<typeof RpcLiveActivityRegistrationSchema>, RpcLiveActivityRegistration>
>;
