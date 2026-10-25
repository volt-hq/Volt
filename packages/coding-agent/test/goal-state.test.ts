import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { ExtensionAPI } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { auditorApproved } from "../../../.volt/extensions/goal/auditor.ts";
import { auditTools } from "../../../.volt/extensions/goal/index.ts";
import {
	assertCompletable,
	createGoal,
	emptyState,
	goalSummary,
	type Proposal,
	restoreState,
	STATE_ENTRY,
	updateTask,
} from "../../../.volt/extensions/goal/state.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const proposal: Proposal = {
	objective: "Fix the parser",
	requirements: ["Accept valid input", "Reject invalid input"],
	tasks: [
		{ title: "Implement parser", requirement: "Accept valid input" },
		{ title: "Verify parser", requirement: "Run focused tests" },
	],
};

describe("goal state", () => {
	it("restores an owned snapshot from the last entry, ignoring other types", () => {
		const state = { ...emptyState(), goal: createGoal(proposal, "regular"), revision: 2 };
		const entries = [
			{ type: "custom", customType: STATE_ENTRY, data: emptyState() },
			{ type: "custom", customType: STATE_ENTRY, data: state },
			{ type: "custom", customType: "other", data: {} },
		];
		const restored = restoreState(entries);
		expect(restored).toEqual(state);
		restored.goal!.tasks[0].title = "different";
		expect(state.goal.tasks[0].title).toBe("Implement parser");
		expect(restoreState([])).toEqual(emptyState());
	});

	it("fails closed on an invalid latest snapshot instead of resuming an older goal", () => {
		expect(() =>
			restoreState([
				{ type: "custom", customType: STATE_ENTRY, data: emptyState() },
				{ type: "custom", customType: STATE_ENTRY, data: { version: 99 } },
			]),
		).toThrow("saved goal state is invalid");
	});

	it("rejects blank or oversized proposals and empty ordered plans", () => {
		expect(() => createGoal({ ...proposal, objective: " " }, "regular")).toThrow("nonempty objective");
		expect(() => createGoal({ ...proposal, tasks: [] }, "ordered")).toThrow("at least one step");
		expect(() => createGoal({ ...proposal, objective: "x".repeat(17_000) }, "regular")).toThrow("16 KB");
	});

	it("requires task evidence and enforces ordered completion without skipping", () => {
		let goal = createGoal(proposal, "ordered");
		expect(() => updateTask(goal, "2", "complete", "tested")).toThrow("preceding");
		expect(() => updateTask(goal, "1", "complete", " ")).toThrow("evidence");
		expect(() => updateTask(goal, "1", "skipped", "optional")).toThrow("cannot be skipped");
		expect(() => assertCompletable(goal)).toThrow("remaining tasks");
		goal = updateTask(goal, "1", "complete", "implemented");
		goal = updateTask(goal, "2", "complete", "tested");
		expect(() => assertCompletable(goal)).not.toThrow();
		expect(goal.status).toBe("active");
		expect(goalSummary(goal)).toContain("Evidence/reason: tested");
		goal = updateTask(goal, "1", "active", "rechecking");
		expect(goal.tasks.map((task) => task.status)).toEqual(["active", "pending"]);
		expect(goal.tasks[1].evidence).toBe("");
	});

	it("permits explained skips only in regular mode and prevents paused progress", () => {
		const goal = createGoal(proposal, "regular");
		expect(updateTask(goal, "2", "skipped", "not applicable").tasks[1].status).toBe("skipped");
		expect(() => updateTask({ ...goal, status: "paused" }, "1", "active", "")).toThrow("Resume");
		expect(() => updateTask(goal, "missing", "active", "")).toThrow("Unknown");
	});
});

describe("goal audit boundary", () => {
	it.each([
		["Verified requirements.\n<approved/>", true],
		["  Verified.\n<approved/>\n ", true],
		["I would say <approved/> but tests failed.", false],
		["<approved/>\nUnverified tests", false],
		["Report\n<disapproved/>", false],
		["", false],
	])("reads only a final standalone approval marker: %s", (text, approved) => {
		expect(auditorApproved(text)).toBe(approved);
	});

	it("intersects active tools with trusted native read/bash, never an override", () => {
		const metadata: ReturnType<ExtensionAPI["getAllTools"]> = ["read", "bash", "write", "mcp"].map((name) => ({
			name,
			description: name,
			parameters: Type.Object({}),
			sourceInfo: {
				source: name === "bash" ? "sdk" : "builtin",
				path: `<${name}>`,
				scope: "temporary",
				origin: "top-level",
			},
		}));
		expect(
			auditTools({ getActiveTools: () => ["read", "bash", "write", "mcp"], getAllTools: () => metadata }),
		).toEqual(["read"]);
		expect(auditTools({ getActiveTools: () => ["bash"], getAllTools: () => metadata })).toEqual([]);
	});

	it("reports base tool overrides as SDK tools, so the auditor never swaps them for native read/bash", async () => {
		const restricted = (name: string): AgentTool => ({
			name,
			label: name,
			description: `Restricted ${name}`,
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "restricted" }], details: {} }),
		});
		const toolsOf = (harness: Harness) => ({
			getActiveTools: () => harness.session.getActiveToolNames(),
			getAllTools: () => harness.session.getAllTools(),
		});
		const overridden = await createHarness({ tools: [restricted("read"), restricted("bash")] });
		const native = await createHarness();
		try {
			const overrides = overridden.session.getAllTools().filter((tool) => ["read", "bash"].includes(tool.name));
			expect(overrides.map((tool) => tool.name).sort()).toEqual(["bash", "read"]);
			for (const tool of overrides) {
				expect(tool.sourceInfo).toMatchObject({ path: `<sdk:${tool.name}>`, source: "sdk" });
			}
			expect(overridden.session.getActiveToolNames().sort()).toEqual(["bash", "read"]);
			expect(auditTools(toolsOf(overridden))).toEqual([]);

			expect(auditTools(toolsOf(native)).sort()).toEqual(["bash", "read"]);
		} finally {
			overridden.cleanup();
			native.cleanup();
		}
	});
});
