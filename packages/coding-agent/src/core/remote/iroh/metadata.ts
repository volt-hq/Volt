import type { IrohRemoteClientAuthorizationSuccess } from "./authorization.ts";
import { IROH_REMOTE_HOST_FEATURES, type IrohRemoteRelayMode } from "./protocol.ts";
import type { IrohRemoteWorkspaceStatus } from "./workspace.ts";

export interface IrohRemoteHostMetadata {
	workspace: string;
	workspaceNames: string[];
	workspaces: IrohRemoteWorkspaceStatus[];
	features: string[];
	hostNodeId?: string;
	relayMode?: IrohRemoteRelayMode;
	/** Current relay fleet; lets clients refresh their relay list without re-pairing. */
	relayUrls?: string[];
	hostName?: string;
	userName?: string;
	cwd: string;
}

export interface CreateIrohRemoteHostMetadataOptions {
	authorization: IrohRemoteClientAuthorizationSuccess;
	hostNodeId?: string;
	relayMode?: IrohRemoteRelayMode;
	relayUrls?: string[];
	hostName?: string;
	userName?: string;
	cwd?: string;
	features?: string[];
}

export function createIrohRemoteHostMetadata(options: CreateIrohRemoteHostMetadataOptions): IrohRemoteHostMetadata {
	return {
		workspace: options.authorization.workspace.name,
		workspaceNames: [...options.authorization.workspaceNames],
		workspaces: options.authorization.workspaces.map((workspace) => ({ ...workspace })),
		features: [...(options.features ?? IROH_REMOTE_HOST_FEATURES)],
		hostNodeId: options.hostNodeId,
		relayMode: options.relayMode,
		relayUrls: options.relayUrls,
		hostName: options.hostName,
		userName: options.userName,
		cwd: options.cwd ?? "/workspace",
	};
}
