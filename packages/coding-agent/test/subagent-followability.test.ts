import { describe, expect, it } from "vitest";
import { SubagentRegistry } from "../src/core/subagents/registry.ts";
import { createSubagentRegistryTool, type SubagentToolManager } from "../src/core/tools/subagent.ts";

function registerRunning(registry: SubagentRegistry, id: string, parentId?: string): void {
	registry.register({
		id,
		...(parentId === undefined ? {} : { parentId }),
		agent: { name: "researcher", source: "built-in" },
		path: ["researcher"],
	});
}

describe("subagent registry followability", () => {
	it("classifies current, ancestor, dependency-cycle, and safe targets for the caller", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_parent");
		registerRunning(registry, "sa_child", "sa_parent");
		registerRunning(registry, "sa_waiting_sibling", "sa_parent");
		registerRunning(registry, "sa_safe_sibling", "sa_parent");
		registerRunning(registry, "sa_done", "sa_parent");
		registry.complete("sa_done", "completed", { output: "done" });

		const siblingFollow = registry.follow("sa_waiting_sibling", "sa_child");
		const followability = Object.fromEntries(
			registry.listForFollower("sa_child").map((record) => [record.id, record.followability]),
		);

		expect(followability).toEqual({
			sa_child: "current",
			sa_waiting_sibling: "dependency-cycle",
			sa_safe_sibling: "followable",
			sa_parent: "ancestor",
			sa_done: "followable",
		});

		registry.complete("sa_child", "completed", { output: "child result" });
		await expect(siblingFollow).resolves.toMatchObject({ output: "child result" });
	});

	it("marks ancestors before a new child has been registered", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_grandparent");
		registerRunning(registry, "sa_parent", "sa_grandparent");

		const followability = Object.fromEntries(
			registry.listForFollower("sa_new_child", "sa_parent").map((record) => [record.id, record.followability]),
		);

		expect(followability).toEqual({
			sa_parent: "ancestor",
			sa_grandparent: "ancestor",
		});
	});

	it("keeps spawn preflights bounded while annotating the caller", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_parent");
		registerRunning(registry, "sa_child", "sa_parent");
		for (let index = 0; index < 60; index += 1) {
			const id = `sa_done_${index}`;
			registerRunning(registry, id);
			registry.complete(id, "completed");
		}

		const preflight = registry.prepareSpawnConfirmation("request", "sa_child");
		const followability = Object.fromEntries(preflight.records.map((record) => [record.id, record.followability]));

		expect(preflight.records).toHaveLength(50);
		expect(preflight.total).toBe(62);
		expect(followability.sa_child).toBe("current");
		expect(followability.sa_parent).toBe("ancestor");
	});

	it("rejects self and ancestor follows with caller-specific errors", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_parent");
		registerRunning(registry, "sa_child", "sa_parent");

		await expect(registry.follow("sa_child", "sa_child")).rejects.toThrow("current runtime");
		await expect(registry.follow("sa_child", "sa_parent")).rejects.toThrow(
			"ancestor waiting for the current runtime",
		);
	});

	it("shows caller-relative followability in model-visible registry results", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_parent");
		registerRunning(registry, "sa_child", "sa_parent");
		registerRunning(registry, "sa_sibling", "sa_parent");
		const manager = {
			getDefinition: () => {
				throw new Error("unused");
			},
			startByName: async () => {
				throw new Error("unused");
			},
			listDelegationsForCaller: () => registry.listForFollower("sa_child"),
			followDelegation: async () => {
				throw new Error("unused");
			},
		} satisfies SubagentToolManager;
		const tool = createSubagentRegistryTool(process.cwd(), { manager });

		const result = await tool.execute("call-list", { list: true });
		const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");

		expect(text).toContain("sa_child researcher running [current run; not followable]");
		expect(text).toContain("sa_parent researcher running [ancestor; not followable]");
		expect(text).toContain("sa_sibling researcher running [followable]");
		expect(text).toContain("Only records marked [followable]");
	});
});
