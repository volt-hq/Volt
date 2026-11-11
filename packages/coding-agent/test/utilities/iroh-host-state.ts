import { rmSync } from "node:fs";
import {
	allocateIrohRemoteWorkspaceGeneration,
	createEmptyIrohRemoteHostState,
	type IrohRemoteHostState,
} from "../../src/core/remote/iroh/state.ts";
import { getDaemonPaths } from "../../src/daemon/paths.ts";
import { VoltdStateStore } from "../../src/daemon/state.ts";

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

/**
 * Write the daemon's state file of `agentDir` anew, as the daemon's store
 * writes it, holding the sections of `overrides`: the workspaces and
 * worktrees a local client reads from it.
 */
export async function writeDaemonStateFile(
	agentDir: string,
	overrides: Partial<IrohRemoteHostState> = {},
): Promise<void> {
	const statePath = getDaemonPaths(agentDir).statePath;
	rmSync(statePath, { force: true });
	const store = new VoltdStateStore({ statePath });
	await store.load();
	await store.persistHostState(createIrohRemoteHostStateFixture(overrides));
}
