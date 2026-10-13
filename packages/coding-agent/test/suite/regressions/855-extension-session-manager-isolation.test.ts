import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError } from "../../../src/core/extensions/types.ts";
import type {
	ReadonlySessionManager,
	SessionEntry,
	SessionHeader,
	SessionTreeNode,
} from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const MUTATED = "MUTATED-BY-EXTENSION";
const WINDOW = { maxEntries: 1, lookbackEntries: 10 };

/** Rewrite an entry in place: its id fields, a nested message's content, and an added field. */
function mutateEntry(entry: SessionEntry | SessionHeader | null | undefined): void {
	if (!entry) return;
	entry.id = MUTATED;
	if (entry.type === "session") {
		entry.cwd = MUTATED;
	} else {
		entry.parentId = MUTATED;
	}
	if (entry.type === "message") {
		const { message } = entry;
		if (message.role === "user") message.content = MUTATED;
		if (message.role === "assistant") message.content.push({ type: "text", text: MUTATED });
	}
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

describe("regression #855: extensions read copies of the session's entries through ctx.sessionManager", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		// Cleanup asserts that the fold of the session's log equals the session's view.
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps an extension's changes to what it read from the session and from later readers", async () => {
		const seen: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("agent_end", (_event, ctx) => {
						seen.push(snapshot(ctx.sessionManager));
					});
				},
				(volt) => {
					volt.on("agent_end", (_event, ctx) => mutateEverythingRead(ctx.sessionManager));
					// A later handler of the same extension reads the session unchanged.
					volt.on("agent_end", (_event, ctx) => {
						seen.push(snapshot(ctx.sessionManager));
					});
				},
				(volt) => {
					volt.on("agent_end", (_event, ctx) => {
						seen.push(snapshot(ctx.sessionManager));
					});
				},
			],
		});
		harnesses.push(harness);
		const errors: ExtensionError[] = [];
		harness.session.extensionRunner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);

		await harness.session.prompt("first question");
		await harness.session.prompt("second question");

		expect(errors).toEqual([]);
		expect(seen).toHaveLength(6);
		expect(seen[0]).toContain("first question");
		expect(seen[3]).toContain("second question");
		expect(seen).toEqual([seen[0], seen[0], seen[0], seen[3], seen[3], seen[3]]);
		expect(seen[3]).not.toContain(MUTATED);
		expect(snapshot(harness.sessionManager)).toBe(seen[3]);
	});
});
