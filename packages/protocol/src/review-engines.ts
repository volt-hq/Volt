import { type Static, Type } from "typebox";
import { ExtensionIdSchema, ExtensionSettingsSchema } from "./extensions.ts";
import { stringEnum } from "./helpers.ts";

/**
 * A review engine an extension registered, as a client offers it: the id a review start names (`engine` of the
 * `review` intent), the words and options it takes, and what it costs. A remote client is told only of the
 * engines a paired device may start, with the parameters it may set.
 */
export const RpcReviewEngineSchema = Type.Object(
	{
		/** `ext:<extension id>/<name>`: what the `review` intent's `engine` takes. */
		id: Type.String({ minLength: 1, maxLength: 160 }),
		/** The engine's name within its extension: what a command line may say when it is unambiguous. */
		name: Type.String({ minLength: 1, maxLength: 64 }),
		extension: ExtensionIdSchema,
		label: Type.String(),
		description: Type.String(),
		/** What choosing it costs compared with the standard review. */
		cost: Type.Optional(Type.String()),
		targets: Type.Array(stringEnum(["uncommitted", "branch", "branch_uncommitted", "pr", "commit"]), { minItems: 1 }),
		remoteSafe: Type.Boolean(),
		/** The options the engine takes (`engineParams`), declared as an extension's settings are. */
		parameters: Type.Optional(ExtensionSettingsSchema),
		/** The parameters only a client at the host may set. Never sent to a remote client, which is not told of them. */
		localOnly: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);
export type RpcReviewEngine = Static<typeof RpcReviewEngineSchema>;

export const RpcListReviewEnginesSchema = Type.Object(
	{ engines: Type.Array(RpcReviewEngineSchema, { maxItems: 128 }) },
	{ additionalProperties: false },
);
export type RpcListReviewEngines = Static<typeof RpcListReviewEnginesSchema>;
