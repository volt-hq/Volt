/**
 * Regression #935: a snapshot projected every entry of the log, presenting
 * every tool call, and then kept only the profile's tail, so a phone's
 * subscribe cost the whole history. The fold now reads each entry's envelope,
 * and only the entries the snapshot carries are projected in full: a tail of
 * N presents at most N tool calls, and the snapshot is unchanged.
 *
 * Each phone's connection also had a profile of its own, and the cache of
 * presentations was kept per profile, so no reconnect reused one. Remote
 * profiles that redact alike now share one projection, and a conversation
 * caches projected entries by it: a second phone's snapshot presents nothing.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ClientSnapshot,
	clientActiveBranch,
	clientFold,
	clientSnapshot,
	REMOTE_CAPABILITIES,
	type ToolPresentation,
} from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import {
	localProfile,
	type Profile,
	type RemoteProfileOptions,
	remoteProfile,
} from "../../../src/core/protocol/profiles.ts";
import { ProjectionCache } from "../../../src/core/protocol/projection/cache.ts";
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
	const projected = manager
		.committedEntriesAfter(0)
		.flatMap((entry) => projectEntry(entry, source, profile.projection) ?? []);
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

const GRANT = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] } as const;

/** A paired device's profile, as each of its connections gets one. */
function phone(
	redaction: RemoteProfileOptions["redaction"] = { workspacePath: CWD },
	limits: RemoteProfileOptions["limits"] = { snapshotTail: TAIL },
): Profile {
	return remoteProfile({ grant: { ...GRANT, capabilities: [...GRANT.capabilities] }, redaction, limits });
}

const PROFILES: ReadonlyArray<readonly [string, Profile]> = [
	["local", { ...localProfile, limits: { ...localProfile.limits, snapshotTail: TAIL } }],
	["remote", phone()],
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

	it("presents nothing for a second phone's snapshot of the same conversation", async () => {
		const manager = await longLog();
		const counting = countingPresenters();
		// The conversation's source: its presenters and the cache of its projected entries.
		const source = sessionProjectionSource(manager, counting.set, new ProjectionCache());
		const first = logSnapshot(manager, phone(), manager.getOrdinal(), source);
		const presented = counting.presented();
		expect(presented).toBeGreaterThan(0);
		const second = logSnapshot(manager, phone(), manager.getOrdinal(), source);
		expect(counting.presented()).toBe(presented);
		expect(JSON.stringify(second)).toBe(JSON.stringify(first));
	});

	it("shares a projection between remote profiles that redact alike within the same bounds", () => {
		const base = phone();
		expect(phone().projection).toBe(base.projection);
		// Limits that do not shape projected entries keep the projection.
		expect(phone(undefined, { snapshotTail: 3, readBurst: 1 }).projection).toBe(base.projection);
		expect(phone({ workspacePath: `${CWD}-other` }).projection).not.toBe(base.projection);
		expect(phone({ workspacePath: CWD, remoteWorkspacePath: "/elsewhere" }).projection).not.toBe(base.projection);
		expect(phone({ workspacePath: CWD, additionalRedactedPaths: ["/tmp/volt-935/parent"] }).projection).not.toBe(
			base.projection,
		);
		expect(phone(undefined, { textScalars: 10 }).projection).not.toBe(base.projection);
		expect(phone(undefined, { presentationBytes: 1_024 }).projection).not.toBe(base.projection);
	});

	it("projects anew for a root whose symlink now names another directory", () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "volt-935-")));
		try {
			const link = join(dir, "workspace");
			const type = process.platform === "win32" ? "junction" : "dir";
			for (const target of ["a", "b"]) mkdirSync(join(dir, target));
			symlinkSync(join(dir, "a"), link, type);
			const before = phone({ workspacePath: link });
			expect(phone({ workspacePath: link }).projection).toBe(before.projection);
			unlinkSync(link);
			symlinkSync(join(dir, "b"), link, type);
			const after = phone({ workspacePath: link });
			expect(after.projection).not.toBe(before.projection);
			const moved = join(dir, "b", "file.ts");
			expect(after.projection.source(moved)).toBe("/workspace/file.ts");
			expect(before.projection.source(moved)).toBe(moved);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
