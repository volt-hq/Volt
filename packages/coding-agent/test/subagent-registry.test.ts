import { describe, expect, it } from "vitest";
import { SubagentRegistry } from "../src/core/subagents/registry.ts";

function registerRunning(
	registry: SubagentRegistry,
	id: string,
	options: { parentId?: string; name?: string; task?: string } = {},
): void {
	registry.register({
		id,
		...(options.parentId !== undefined ? { parentId: options.parentId } : {}),
		agent: { name: options.name ?? "researcher", source: "built-in" },
		path: [options.name ?? "researcher"],
	});
	if (options.task !== undefined) {
		registry.setTask(id, options.task);
	}
}

describe("SubagentRegistry", () => {
	it("lists records running first, then newest first", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_first", { task: "first task" });
		registerRunning(registry, "sa_second", { task: "second task" });
		registry.complete("sa_first", "completed", { output: "first output" });
		registerRunning(registry, "sa_third", { task: "third task" });

		expect(registry.list().map((record) => record.id)).toEqual(["sa_third", "sa_second", "sa_first"]);
		expect(registry.list().map((record) => record.status)).toEqual(["running", "running", "completed"]);
	});

	it("keeps the first task and bounds long prompts", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_1", { task: "x".repeat(5_000) });
		registry.setTask("sa_1", "replacement");

		const task = registry.get("sa_1")?.task;
		expect(task).toHaveLength(2_000);
		expect(task?.startsWith("xxx")).toBe(true);
		expect(task?.endsWith("…")).toBe(true);
	});

	it("returns completed results immediately and bounds stored output", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_1", { task: "research file x" });
		registry.complete("sa_1", "completed", { output: "y".repeat(60_000) });

		const result = await registry.follow(undefined, "sa_1");
		expect(result.status).toBe("completed");
		expect(result.task).toBe("research file x");
		expect(result.output).toHaveLength(50_000);
		expect(result.finishedAt).toBeGreaterThanOrEqual(result.startedAt);
	});

	it("ignores completions after the first terminal transition", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_1");
		registry.complete("sa_1", "completed", { output: "first" });
		registry.complete("sa_1", "failed", { error: "late failure" });

		const result = await registry.follow(undefined, "sa_1");
		expect(result.status).toBe("completed");
		expect(result.output).toBe("first");
		expect(result.error).toBeUndefined();
	});

	it("resolves waiting followers when the target completes", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_target", { task: "long research" });

		const following = registry.follow(undefined, "sa_target");
		registry.complete("sa_target", "completed", { output: "target output" });

		await expect(following).resolves.toMatchObject({ id: "sa_target", status: "completed", output: "target output" });
	});

	it("rejects waiting followers when their signal aborts", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_target");
		const controller = new AbortController();

		const following = registry.follow(undefined, "sa_target", controller.signal);
		controller.abort();

		await expect(following).rejects.toThrow(/aborted/i);
		// A later completion must not throw because the aborted waiter was removed.
		registry.complete("sa_target", "completed", { output: "done" });
	});

	it("throws for unknown run ids", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_known");
		await expect(registry.follow(undefined, "sa_missing")).rejects.toThrow(
			'Subagent run "sa_missing" is not in the delegation registry. Known runs: sa_known.',
		);
	});

	it("refuses to follow a running ancestor", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_parent");
		registerRunning(registry, "sa_child", { parentId: "sa_parent" });

		await expect(registry.follow("sa_child", "sa_parent")).rejects.toThrow("would deadlock");
	});

	it("refuses mutual follows between running siblings", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_a");
		registerRunning(registry, "sa_b");

		const firstFollow = registry.follow("sa_a", "sa_b");
		await expect(registry.follow("sa_b", "sa_a")).rejects.toThrow("would deadlock");

		registry.complete("sa_b", "completed", { output: "b output" });
		await expect(firstFollow).resolves.toMatchObject({ id: "sa_b", output: "b output" });
	});

	it("refuses follows that deadlock through a running descendant of the target", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_root-call");
		registerRunning(registry, "sa_branch", { parentId: "sa_root-call" });
		registerRunning(registry, "sa_leaf", { parentId: "sa_branch" });

		// sa_leaf waiting on sa_root-call can never resolve: sa_root-call's own
		// completion awaits sa_branch, which awaits sa_leaf.
		await expect(registry.follow("sa_leaf", "sa_root-call")).rejects.toThrow("would deadlock");
	});

	it("allows the root session to follow any running record", async () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_target");

		const following = registry.follow(undefined, "sa_target");
		registry.complete("sa_target", "aborted");

		await expect(following).resolves.toMatchObject({ status: "aborted" });
	});

	it("evicts oldest terminal records over the cap but never running ones", () => {
		const registry = new SubagentRegistry();
		registerRunning(registry, "sa_running-oldest");
		for (let index = 0; index < 510; index += 1) {
			const id = `sa_${index}`;
			registerRunning(registry, id);
			registry.complete(id, "completed");
		}

		const records = registry.list();
		expect(records.length).toBeLessThanOrEqual(500);
		expect(records.some((record) => record.id === "sa_running-oldest")).toBe(true);
		expect(records.some((record) => record.id === "sa_0")).toBe(false);
	});
});
