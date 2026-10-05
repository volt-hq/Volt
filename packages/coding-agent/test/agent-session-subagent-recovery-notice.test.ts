/**
 * After a reload, the first prompt surfaces the subagent runs of the
 * conversation that a restart left suspended as one persisted custom-message
 * notice, deduplicated durably against notices already in the transcript.
 * Nothing resumes on its own: the notice tells the model how to resume.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE } from "../src/core/session/lifecycle.ts";
import { type CustomMessageEntry, SessionManager } from "../src/core/session-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { type SubagentDefinition, SubagentManager, type SubagentRegistryRecord } from "../src/core/subagents/index.ts";
import type { SubagentToolManager } from "../src/core/tools/index.ts";
import { createHarness } from "./test-harness.ts";
import { seedSession } from "./utilities/seed-log.ts";
import { createTestResourceLoader } from "./utilities.ts";

function record(overrides: Partial<SubagentRegistryRecord> & { id: string }): SubagentRegistryRecord {
	return {
		sequence: 0,
		agent: { name: "researcher" },
		path: ["researcher"],
		status: "suspended",
		startedAt: 1,
		finishedAt: 2,
		...overrides,
	};
}

function createStubManager(
	records: SubagentRegistryRecord[],
	options: { isSubagentRuntime?: boolean } = {},
): {
	manager: SubagentToolManager;
	hydrateCalls: () => number;
} {
	const ensureRegistryHydrated = vi.fn(async () => {});
	const manager: SubagentToolManager = {
		getDefinition: () => {
			throw new Error("not used");
		},
		startByName: () => {
			throw new Error("not used");
		},
		isSubagentRuntime: () => options.isSubagentRuntime === true,
		ensureRegistryHydrated,
		listDelegations: () => records,
	};
	return { manager, hydrateCalls: () => ensureRegistryHydrated.mock.calls.length };
}

function noticeEntries(harness: { sessionManager: { getEntries(): Array<{ type: string }> } }): CustomMessageEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter(
			(entry): entry is CustomMessageEntry =>
				entry.type === "custom_message" &&
				(entry as CustomMessageEntry).customType === SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
		);
}

describe("subagent recovery notice", () => {
	it("offers this conversation's suspended runs once, before the first user message", async () => {
		const { manager, hydrateCalls } = createStubManager([
			record({ id: "sa_unclaimed", task: "inspect\nthe   incident" }),
			record({ id: "sa_interrupted", status: "interrupted", error: "Interrupted before completion" }),
			record({ id: "sa_completed", status: "completed" }),
			record({ id: "sa_nested", parentId: "sa_unclaimed" }),
			record({ id: "sa_live", status: "running" }),
		]);
		const harness = await createHarness({ responses: ["ok", "ok"], subagentToolManager: manager });
		try {
			await harness.session.prompt("hello");

			const notices = noticeEntries(harness);
			expect(notices).toHaveLength(1);
			expect(notices[0].details).toEqual({ subagentIds: ["sa_unclaimed"] });
			const text = notices[0].content as string;
			expect(text).toContain("sa_unclaimed");
			expect(text).toContain("inspect the incident");
			expect(text).not.toContain("sa_interrupted");
			expect(text).not.toContain("sa_completed");
			// A descendant's run resumes from its own parent's conversation.
			expect(text).not.toContain("sa_nested");
			expect(text).not.toContain("sa_live");
			expect(text).toContain('{ "resume": "<id>" }');
			expect(text).toContain("unless the user asks");

			// The feature's point: the model sees the notice in THIS turn's
			// provider context, not after the next reload. Custom messages reach
			// the provider transformed, so assert on the notice text.
			const firstTurnContext = JSON.stringify(harness.faux.contexts[0]?.messages ?? []);
			expect(firstTurnContext).toContain("Subagent recovery:");
			expect(firstTurnContext).toContain("sa_unclaimed");

			// Live clients observe the notice through message events at append
			// time, not only via a later transcript reload.
			expect(
				harness.events.some(
					(event) =>
						event.type === "message_end" &&
						event.message.role === "custom" &&
						event.message.customType === SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
				),
			).toBe(true);

			// The notice precedes the user message in entry order.
			const entries = harness.sessionManager.getEntries();
			const noticeIndex = entries.findIndex((entry) => entry.id === notices[0].id);
			const userIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
			expect(noticeIndex).toBeGreaterThanOrEqual(0);
			expect(noticeIndex).toBeLessThan(userIndex);

			// One-shot: a second prompt neither re-hydrates nor re-notices.
			await harness.session.prompt("again");
			expect(noticeEntries(harness)).toHaveLength(1);
			expect(hydrateCalls()).toBe(1);
		} finally {
			harness.cleanup();
		}
	});

	it("durably skips runs already offered by a persisted notice", async () => {
		const { manager } = createStubManager([record({ id: "sa_old" }), record({ id: "sa_new", task: "new work" })]);
		const harness = await createHarness({ responses: ["ok"], subagentToolManager: manager });
		try {
			// A notice persisted by a previous process already offered sa_old.
			await harness.session.sessionWriter.appendCustomMessageEntry(
				SUBAGENT_RECOVERY_NOTICE_CUSTOM_TYPE,
				"prior notice",
				true,
				{
					subagentIds: ["sa_old"],
				},
			);

			await harness.session.prompt("hello");

			const notices = noticeEntries(harness);
			expect(notices).toHaveLength(2);
			expect(notices[1].details).toEqual({ subagentIds: ["sa_new"] });
			expect(notices[1].content as string).not.toContain("sa_old");
		} finally {
			harness.cleanup();
		}
	});

	it("appends nothing when no run is suspended", async () => {
		const { manager } = createStubManager([record({ id: "sa_done", status: "completed" })]);
		const harness = await createHarness({ responses: ["ok"], subagentToolManager: manager });
		try {
			await harness.session.prompt("hello");
			expect(noticeEntries(harness)).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("skips without persisting when the subagent tool is not active", async () => {
		const { manager } = createStubManager([record({ id: "sa_unclaimed" })]);
		// baseToolsOverride replaces the toolset, so "subagent" is not active
		// even though the manager is wired.
		const harness = await createHarness({ responses: ["ok"], subagentToolManager: manager, baseToolsOverride: {} });
		try {
			await harness.session.prompt("hello");
			expect(noticeEntries(harness)).toHaveLength(0);
		} finally {
			harness.cleanup();
		}
	});

	it("end to end: a reopened conversation offers its suspended work, which stays suspended", async () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "subagent-recovery-e2e-"));
		const parent = await SessionManager.create(tmpdir(), sessionDir);
		const child = await SessionManager.create(tmpdir(), sessionDir);
		const childRef = child.getSessionRef()!;
		await seedSession(child, (seed) => seed.user("audit the daemon").assistant("halfway through"));
		await child.closePersistence();
		// The shape a closed runtime leaves: open subagent work over a persisted child.
		await seedSession(parent, (seed) =>
			seed.user("audit everything").hostRecord("work_started", {
				workId: "sa_e2e",
				kind: "subagent",
				title: "researcher: audit the daemon",
				input: { agent: "researcher", task: "audit the daemon" },
				cancellable: true,
				delivery: "none",
				resume: true,
				state: "running",
				child: { conversation: childRef.sessionId, ref: childRef },
			}),
		);

		const definition: SubagentDefinition = {
			name: "researcher",
			description: "Research the task",
			systemPrompt: "Research the task.",
			source: "user",
			sourceInfo: createSyntheticSourceInfo(join(tmpdir(), "subagent-recovery-e2e.md"), {
				source: "local",
				scope: "user",
			}),
			filePath: join(tmpdir(), "subagent-recovery-e2e.md"),
		};
		const resourceLoader: ResourceLoader = {
			...createTestResourceLoader(),
			getSubagents: () => ({ definitions: [definition], diagnostics: [] }),
		};
		await parent.closePersistence();
		const reopened = await SessionManager.open(parent.getSessionRef()!);
		const manager = new SubagentManager({
			createRuntime: async () => {
				throw new Error("Hydration must not create runtimes");
			},
			cwd: tmpdir(),
			agentDir: tmpdir(),
			resourceLoader,
			parentSessionManager: reopened,
		});
		const harness = await createHarness({
			responses: ["ok"],
			sessionManager: reopened,
			subagentToolManager: manager,
		});
		try {
			await harness.session.prompt("continue where we left off");

			const notices = noticeEntries(harness);
			expect(notices).toHaveLength(1);
			const text = notices[0].content as string;
			expect(text).toContain("sa_e2e");
			expect(text).toContain("audit the daemon");
			// The notice spent this turn only: the run is still suspended.
			expect(harness.session.work.get("sa_e2e")?.outcome).toBeUndefined();
			expect(harness.session.work.running()).toEqual([]);
			await expect(manager.followDelegation("sa_e2e")).resolves.toMatchObject({ status: "suspended" });
		} finally {
			harness.cleanup();
			await harness.session.waitForClosed();
			await manager.dispose();
		}
	});

	it("never leaks a root-registry notice into a subagent child runtime", async () => {
		// Children share the root registry, so recovered root work is visible
		// through listDelegations — but a child transcript must stay clean.
		const { manager, hydrateCalls } = createStubManager([record({ id: "sa_unclaimed" })], {
			isSubagentRuntime: true,
		});
		const harness = await createHarness({ responses: ["ok"], subagentToolManager: manager });
		try {
			await harness.session.prompt("do the delegated task");
			expect(noticeEntries(harness)).toHaveLength(0);
			expect(hydrateCalls()).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});
