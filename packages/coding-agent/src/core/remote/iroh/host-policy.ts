import { hasTrustRequiringProjectResources } from "../../trust-manager.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "./authorization.ts";
import type { IrohRemoteWorkspace } from "./state.ts";

export interface IrohRemoteWorkspaceTrustStore {
	get(cwd: string): boolean | null;
}

export interface ResolveIrohRemoteWorkspaceProjectTrustOptions {
	approvedWorkspacePaths?: ReadonlySet<string>;
	hasTrustRequiringProjectResources?: (cwd: string) => boolean;
	/**
	 * Where the project resources load from: the workspace, or a managed
	 * worktree checkout of it. Resources that need trust are looked for here;
	 * the decision is the workspace's. `workspace.path` by default.
	 */
	resourcesRoot?: string;
	trustStore?: IrohRemoteWorkspaceTrustStore;
}

/**
 * The project trust of a remote conversation loading project resources from
 * `options.resourcesRoot`: trusted when nothing there needs trust, else as
 * decided for the workspace (#1034).
 */
export function resolveIrohRemoteWorkspaceProjectTrusted(
	workspace: IrohRemoteWorkspace,
	options: ResolveIrohRemoteWorkspaceProjectTrustOptions = {},
): boolean {
	if (options.approvedWorkspacePaths?.has(workspace.path)) {
		return true;
	}
	const hasTrustResources = (options.hasTrustRequiringProjectResources ?? hasTrustRequiringProjectResources)(
		options.resourcesRoot ?? workspace.path,
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
