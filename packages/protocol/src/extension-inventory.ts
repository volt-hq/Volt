/**
 * The extension inventory: what a new conversation in a workspace (or one of
 * its worktree checkouts) would load and register, predicted before any
 * conversation exists. Its items are the same shapes the live `extensions`
 * and `review.engines` queries list, so a client reads predicted and live
 * answers alike; a live conversation stays authoritative for what runs.
 */

import { type Static, Type } from "typebox";
import { ExtensionSummarySchema } from "./extensions.ts";
import { IrohRemoteWorktreeIdSchema } from "./remote-handshake.ts";
import { RpcReviewEngineSchema } from "./review-engines.ts";
import { IrohRemoteWorkspaceNameSchema } from "./workspace.ts";

const closed = { additionalProperties: false } as const;

/** Where the inventory is evaluated: a worktree checkout of the workspace, or its root when absent. */
export const RpcExtensionInventoryParamsSchema = Type.Object(
	{ worktreeId: Type.Optional(IrohRemoteWorktreeIdSchema) },
	closed,
);
export type RpcExtensionInventoryParams = Static<typeof RpcExtensionInventoryParamsSchema>;

export const RpcExtensionInventorySchema = Type.Object(
	{
		/** The workspace it was evaluated for: the stream's own. */
		workspaceName: IrohRemoteWorkspaceNameSchema,
		/** Echoed when the inventory is a worktree checkout's. */
		worktreeId: Type.Optional(IrohRemoteWorktreeIdSchema),
		/** Whether the project is trusted, so its own extensions and settings were included. */
		projectTrusted: Type.Boolean(),
		/** Every extension a conversation there would declare, enabled or not, as the `extensions` query lists them. */
		extensions: Type.Array(ExtensionSummarySchema),
		/** The review engines its active extensions register, as the `review.engines` query lists them. */
		reviewEngines: Type.Array(RpcReviewEngineSchema, { maxItems: 128 }),
	},
	closed,
);
export type RpcExtensionInventory = Static<typeof RpcExtensionInventorySchema>;
