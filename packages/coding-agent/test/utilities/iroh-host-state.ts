import {
	allocateIrohRemoteWorkspaceGeneration,
	createEmptyIrohRemoteHostState,
	type IrohRemoteHostState,
} from "../../src/core/remote/iroh/state.ts";

/**
 * A complete host state from the sections a test cares about. Every workspace
 * without a generation record gets one, as registering it would.
 */
export function createIrohRemoteHostStateFixture(overrides: Partial<IrohRemoteHostState> = {}): IrohRemoteHostState {
	const state: IrohRemoteHostState = { ...createEmptyIrohRemoteHostState(), ...overrides };
	for (const workspace of state.workspaces) {
		if (!state.workspaceGenerations.some((record) => record.workspaceName === workspace.name)) {
			allocateIrohRemoteWorkspaceGeneration(state, workspace.name);
		}
	}
	return state;
}
