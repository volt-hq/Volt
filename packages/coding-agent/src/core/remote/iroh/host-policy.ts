import { hasTrustRequiringProjectResources } from "../../trust-manager.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "./authorization.ts";
import type { IrohRemoteWorkspace } from "./state.ts";

export interface IrohRemoteWorkspaceTrustStore {
	get(cwd: string): boolean | null;
}

export interface ResolveIrohRemoteWorkspaceProjectTrustOptions {
	approvedWorkspacePaths?: ReadonlySet<string>;
	hasTrustRequiringProjectResources?: (cwd: string) => boolean;
	trustStore?: IrohRemoteWorkspaceTrustStore;
}

export function resolveIrohRemoteWorkspaceProjectTrusted(
	workspace: IrohRemoteWorkspace,
	options: ResolveIrohRemoteWorkspaceProjectTrustOptions = {},
): boolean {
	if (options.approvedWorkspacePaths?.has(workspace.path)) {
		return true;
	}
	const hasTrustResources = (options.hasTrustRequiringProjectResources ?? hasTrustRequiringProjectResources)(
		workspace.path,
	);
	if (!hasTrustResources) {
		return true;
	}
	return options.trustStore?.get(workspace.path) === true;
}

export function shouldReplaceIrohRemoteIntegratedRuntimeForAuthorization(
	authorization: Pick<IrohRemoteClientAuthorizationSuccess, "paired">,
): boolean {
	return authorization.paired;
}
