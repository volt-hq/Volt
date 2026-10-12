// Regression for #801: a conversation that only ran work (a `work_started`,
// no messages and no plan) is listed like one with messages, so /resume,
// `volt -r`, and remote session lists can return to it.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/core/extensions/index.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
});

const sweep: ExtensionFactory = (volt) => {
	volt.registerWorkKind("sweep");
	volt.registerCommand("sweep", {
		handler: async (_args, ctx) => {
			await ctx.startWork("sweep", { title: "Sweep the repo" }, async () => ({ outcome: "completed" }));
		},
	});
};

async function listedIds(harness: Harness): Promise<string[]> {
	const sessions = await SessionManager.list(harness.tempDir, join(harness.tempDir, "sessions"));
	return sessions.map((session) => session.id);
}

describe("#801 work-only conversation listing", () => {
	it("lists a conversation once it records work, without any message or plan", async () => {
		const harness = await createHarness({
			log: "sqlite",
			extensionFactories: [sweep],
			settings: { lsp: { enabled: false } },
		});
		harnesses.push(harness);
		const sessionId = harness.sessionManager.getSessionId();
		expect(await listedIds(harness)).not.toContain(sessionId);

		await harness.session.prompt("/sweep");
		await harness.session.work.waitForIdle();
		expect(harness.session.work.list()).toMatchObject([{ kind: "ext:inline-1/sweep", outcome: "completed" }]);
		expect(harness.sessionManager.getSessionEntrySummary().messageCount).toBe(0);
		expect(harness.sessionManager.getConversationState().planning).toBeNull();

		expect(await listedIds(harness)).toEqual([sessionId]);
		// The stored listing state is the one a replay of the log derives: the session reopens.
		const reopened = await SessionManager.openReadOnly(harness.sessionManager.getSessionRef()!);
		await reopened.closePersistence();
	});
});
