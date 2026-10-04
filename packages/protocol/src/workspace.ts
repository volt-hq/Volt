/**
 * Registered-workspace vocabulary shared by the Iroh handshake and the daemon
 * control plane: the workspace name grammar and the per-client workspace
 * catalog (names and availability, never paths).
 */

import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";

/** Workspace names count Unicode code points; 255 of them always fit the 1024-byte budget. */
export const IROH_REMOTE_WORKSPACE_NAME_MAX_CODE_POINTS = 255;
export const IROH_REMOTE_WORKSPACE_NAME_MAX_UTF8_BYTES = 1024;

/** 1-255 code points, no ASCII control characters. */
export const IrohRemoteWorkspaceNameSchema = Type.String({
	maxLength: IROH_REMOTE_WORKSPACE_NAME_MAX_CODE_POINTS,
	pattern: `^[^\\u0000-\\u001f\\u007f]{1,${IROH_REMOTE_WORKSPACE_NAME_MAX_CODE_POINTS}}$`,
	"x-volt-max-utf8-bytes": IROH_REMOTE_WORKSPACE_NAME_MAX_UTF8_BYTES,
	"x-volt-expected": "be a workspace name of 1-255 characters without ASCII control characters",
});

export const IrohRemoteWorkspaceAvailabilityStatusSchema = stringEnum(["available", "missing", "unavailable"], {
	"x-volt-expected": "be a supported workspace status",
});
export type IrohRemoteWorkspaceAvailabilityStatus = Static<typeof IrohRemoteWorkspaceAvailabilityStatusSchema>;

export const IrohRemoteWorkspaceStatusSchema = Type.Object(
	{ name: IrohRemoteWorkspaceNameSchema, status: IrohRemoteWorkspaceAvailabilityStatusSchema },
	{ additionalProperties: false },
);
export type IrohRemoteWorkspaceStatus = Static<typeof IrohRemoteWorkspaceStatusSchema>;

/** The workspaces one paired client may see: available names plus every authorized workspace's status. */
export const IrohRemoteWorkspaceMetadataSnapshotSchema = Type.Object(
	{
		workspaceNames: Type.Array(IrohRemoteWorkspaceNameSchema),
		workspaces: Type.Array(IrohRemoteWorkspaceStatusSchema),
	},
	{ additionalProperties: false },
);
export type IrohRemoteWorkspaceMetadataSnapshot = Static<typeof IrohRemoteWorkspaceMetadataSnapshotSchema>;
