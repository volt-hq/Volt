/**
 * Regression #935: a snapshot projected every entry of the log, presenting
 * every tool call, and then kept only the profile's tail, so a phone's
 * subscribe cost the whole history. The fold now reads each entry's envelope,
 * and only the entries the snapshot carries are projected in full: a tail of
 * N presents at most N tool calls, and the snapshot is unchanged.
 */

import {
	type ClientSnapshot,
	clientActiveBranch,
	clientFold,
	clientSnapshot,
	REMOTE_CAPABILITIES,
	type ToolPresentation,
} from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { localProfile, type Profile, remoteProfile } from "../../../src/core/protocol/profiles.ts";
import { projectEntry, sessionProjectionSource } from "../../../src/core/protocol/projection/entries.ts";
import { logSnapshot } from "../../../src/core/protocol/server/subscription.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { HOST_UI_POLICY, type PresenterSet } from "../../../src/core/ui/presentation.ts";
import { seedSession } from "../../utilities/seed-log.ts";

const CWD = "/tmp/volt-935/workspace";
const TURNS = 60;
const TAIL = 10;

/** A presenter set whose tool presenter counts the calls it presents. */
function countingPresenters(): { readonly set: PresenterSet; readonly presented: () => number } {
	let presented = 0;
	const present = (): ToolPresentation => {
		presented++;
		return { title: "Read a file" };
	};
	return {
		set: { generation: 0, tool: () => ({ present, policy: HOST_UI_POLICY }), message: () => undefined },
		presented: () => presented,
	};
}

/** The snapshot as the fold of every projected entry, bounded to the profile's tail. */
function foldedLogSnapshot(manager: SessionManager, profile: Profile): ClientSnapshot {
	const source = sessionProjectionSource(manager);
	const projected = manager.committedEntriesAfter(0).flatMap((entry) => projectEntry(entry, source, profile) ?? []);
	const state = clientFold(projected);
	return { ...clientSnapshot(state), entries: clientActiveBranch(state).slice(-TAIL), earlier: true };
}

async function longLog(): Promise<SessionManager> {
	const manager = SessionManager.inMemory(CWD);
	await seedSession(manager, (seed) => {
		for (let turn = 0; turn < TURNS; turn++) {
			const clientMessageId = `client-${turn}`;
			seed.clientInput(clientMessageId, "prompt", { message: `read file ${turn}` }, { states: ["started"] });
			seed.user(`read file ${turn}`, { clientMessageId });
			seed.assistant("", { toolCalls: [{ type: "toolCall", id: `call-${turn}`, name: "read", arguments: {} }] });
			seed.toolResult(`call-${turn}`, `${CWD}/file-${turn}.ts contents`);
			seed.assistant(`done ${turn}`);
		}
	});
	return manager;
}

const PROFILES: ReadonlyArray<readonly [string, Profile]> = [
	["local", { ...localProfile, limits: { ...localProfile.limits, snapshotTail: TAIL } }],
	[
		"remote",
		remoteProfile({
			grant: { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] },
			redaction: { workspacePath: CWD },
			limits: { snapshotTail: TAIL },
		}),
	],
];

describe("regression #935: snapshots project only the entries they carry", () => {
	it.each(PROFILES)("presents at most the tail's tool calls on the %s profile", async (_name, profile) => {
		const manager = await longLog();
		const counting = countingPresenters();
		const snapshot = logSnapshot(
			manager,
			profile,
			manager.getOrdinal(),
			sessionProjectionSource(manager, counting.set),
		);

		expect(snapshot.earlier).toBe(true);
		expect(snapshot.entries).toHaveLength(TAIL);
		expect(counting.presented()).toBeGreaterThan(0);
		expect(counting.presented()).toBeLessThanOrEqual(TAIL);
		expect(JSON.stringify(logSnapshot(manager, profile, manager.getOrdinal()))).toBe(
			JSON.stringify(foldedLogSnapshot(manager, profile)),
		);
	});
});
