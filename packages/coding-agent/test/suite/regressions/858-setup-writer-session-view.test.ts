/**
 * Regression #858: the writer an extension's `ctx.newSession({ setup })` gets
 * reads the new session through a read-only view, not its `SessionManager`.
 * The view has only the `ReadonlySessionManager` methods, and they return
 * copies, so `setup` cannot change the new session's committed entries.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { SessionIntentResult } from "../../../src/core/extensions/index.ts";
import type {
	ReadonlySessionManager,
	SessionEntry,
	SessionHeader,
	SessionTreeNode,
} from "../../../src/core/session-manager.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHostHarness, type HostHarness } from "../host-harness.ts";

const MUTATED = "MUTATED-BY-EXTENSION";
const WINDOW = { maxEntries: 1, lookbackEntries: 10 };

/** Every member of `ReadonlySessionManager`; the compiler keeps the list complete. */
const READONLY_MEMBERS: Record<keyof ReadonlySessionManager, true> = {
	getCwd: true,
	getSessionDir: true,
	getSessionId: true,
	getSessionRef: true,
	getLeafId: true,
	getLeafEntry: true,
	getEntry: true,
	getLabel: true,
	getBranch: true,
	getBranchWindow: true,
	getHeader: true,
	getEntries: true,
	getTree: true,
	getSessionName: true,
};

/** Rewrite an entry in place: its id fields, a nested message's content, and an added field. */
function mutateEntry(entry: SessionEntry | SessionHeader | null | undefined): void {
	if (!entry) return;
	entry.id = MUTATED;
	if (entry.type === "session") {
		entry.cwd = MUTATED;
	} else {
		entry.parentId = MUTATED;
	}
	if (entry.type === "message" && entry.message.role === "user") entry.message.content = MUTATED;
	if (entry.type === "custom") entry.data = MUTATED;
	Object.assign(entry, { marker: MUTATED });
}

function mutateTree(nodes: SessionTreeNode[]): void {
	for (const node of nodes) {
		mutateEntry(node.entry);
		mutateTree(node.children);
	}
}

/** Change every entry, and the header, that each read method of `session` returns. */
function mutateEverythingRead(session: ReadonlySessionManager): void {
	for (const entry of session.getBranch()) mutateEntry(entry);
	for (const entry of session.getEntries()) mutateEntry(entry);
	mutateEntry(session.getLeafEntry());
	const leafId = session.getLeafId();
	if (leafId !== null) mutateEntry(session.getEntry(leafId));
	const window = session.getBranchWindow(WINDOW);
	for (const entry of [...(window?.entries ?? []), ...(window?.lookback ?? [])]) mutateEntry(entry);
	mutateTree(session.getTree());
	mutateEntry(session.getHeader());
}

/** Everything the read methods of `session` return, as text. */
function snapshot(session: ReadonlySessionManager): string {
	const leafId = session.getLeafId();
	return JSON.stringify({
		branch: session.getBranch(),
		entries: session.getEntries(),
		leaf: session.getLeafEntry(),
		entry: leafId === null ? null : session.getEntry(leafId),
		window: session.getBranchWindow(WINDOW),
		tree: session.getTree(),
		header: session.getHeader(),
	});
}

describe("regression #858: the newSession setup writer reads the new session through a read-only view", () => {
	const harnesses: HostHarness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	it("has only the read-only methods, and changing what they return does not change the new session", async () => {
		let members: string[] | undefined;
		let before: string | undefined;
		let afterMutation: string | undefined;
		let seeded: { header: SessionHeader | null; entries: SessionEntry[] } | undefined;
		let opened: { header: SessionHeader | null; entries: (SessionEntry | undefined)[] } | undefined;
		const results: SessionIntentResult[] = [];
		const harness = await createHostHarness({
			extension: (volt) => {
				volt.registerCommand("seed", {
					handler: async (_args, ctx) => {
						results.push(
							await ctx.newSession({
								setup: async (writer) => {
									const session = writer.sessionManager;
									members = Object.keys(session).sort();
									await writer.appendCustomEntry("seeded", { value: "kept" });
									await writer.appendMessage({
										role: "user",
										content: "seeded question",
										timestamp: Date.now(),
									});
									before = snapshot(session);
									// Copied here, so the comparison does not depend on the view's own copies.
									seeded = structuredClone({ header: session.getHeader(), entries: session.getEntries() });
									mutateEverythingRead(session);
									afterMutation = snapshot(session);
								},
								withSession: async (next) => {
									const entries = seeded?.entries ?? [];
									opened = {
										header: next.sessionManager.getHeader(),
										entries: entries.map((entry) => next.sessionManager.getEntry(entry.id)),
									};
								},
							}),
						);
					},
				});
			},
		});
		harnesses.push(harness);
		const source = await harness.openStartup();

		expect(await runPrintMode(harness.host, source, { mode: "text", messages: ["/seed"] })).toBe(0);

		// Host-only members such as takeLog, closePersistence, and getCommittedEntry are not there.
		expect(members).toEqual(Object.keys(READONLY_MEMBERS).sort());
		expect(before).toContain("seeded question");
		expect(before).toContain('"value":"kept"');
		expect(afterMutation).toBe(before);
		expect(afterMutation).not.toContain(MUTATED);
		expect(seeded?.entries.map((entry) => entry.type)).toEqual(expect.arrayContaining(["custom", "message"]));
		expect(results).toEqual([{ cancelled: false, sessionId: expect.any(String), seeded: true }]);
		// The opened session holds the entries and header as `setup` wrote them.
		expect(opened).toEqual(seeded);
	});
});
