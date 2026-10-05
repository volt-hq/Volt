/**
 * Extension work kinds (RFC §7.2): kind declarations, kind ids under manifest
 * ids, ownership of starts, the narrowed context extension work reports
 * through, what of its result the log keeps, and removal.
 */

import { Conversation, InMemoryConversationLog, type StreamFn } from "@hansjm10/volt-agent-core";
import type { LiveItem } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkRunContext, WorkRunResult } from "../src/core/extensions/types.ts";
import { LiveState } from "../src/core/host/live-state.ts";
import {
	type DeclaredWorkKind,
	EXTENSION_KIND_MAX_ACTIVE,
	ExtensionKinds,
	validateWorkKind,
} from "../src/core/work/extension-kinds.ts";
import { WorkRegistry } from "../src/core/work/registry.ts";

const noTurns: StreamFn = () => {
	throw new Error("No turn runs in this test");
};

const opened: Conversation[] = [];

afterEach(async () => {
	for (const conversation of opened.splice(0)) await conversation.close().catch(() => undefined);
});

async function setup(): Promise<{
	conversation: Conversation;
	registry: WorkRegistry;
	kinds: ExtensionKinds;
	live: LiveItem[];
}> {
	const conversation = await Conversation.open({
		log: new InMemoryConversationLog("extension-kinds"),
		stream: noTurns,
		resolveModel: () => undefined,
	});
	opened.push(conversation);
	const liveState = new LiveState({ head: () => conversation.state.ordinal });
	const live: LiveItem[] = [];
	liveState.attach("observer", {
		acceptsHostRequest: () => false,
		apply: (update) => {
			live.push(...update.items);
		},
	});
	const registry = new WorkRegistry({
		conversationId: () => conversation.conversationId,
		work: () => conversation.work,
		state: () => conversation.state,
		live: () => liveState,
		turnId: () => undefined,
	});
	await registry.reconcile();
	return { conversation, registry, kinds: new ExtensionKinds(() => registry), live };
}

const SWARM = "swarm-review";
const OTHER = "other";

function declared(extensionId: string, name: string, kind = {}): DeclaredWorkKind {
	return { extensionId, name, kind: validateWorkKind(name, kind) };
}

/** A run that holds until its signal aborts or it is released. */
function held(): { run: (ctx: WorkRunContext) => Promise<WorkRunResult>; release(result?: WorkRunResult): void } {
	const release = Promise.withResolvers<WorkRunResult>();
	return {
		run: async (ctx) => {
			ctx.signal.addEventListener("abort", () => release.resolve({ outcome: "cancelled" }), { once: true });
			return await release.promise;
		},
		release: (result = { outcome: "completed" }) => release.resolve(result),
	};
}

describe("extension work kinds", () => {
	it("checks and copies a declaration, refusing names and settings outside the kind contract", () => {
		const requires = ["host.manage.v1", "host.manage.v1"] as const;
		const declaration = validateWorkKind("run", { delivery: "message", requires });
		expect(declaration).toEqual({
			delivery: "message",
			cancellable: true,
			maxActive: 1,
			requires: ["host.manage.v1"],
		});
		expect(Object.isFrozen(declaration)).toBe(true);
		for (const name of ["", "Run", "a/b", "ext:x/run", "-run", "a".repeat(65), 7]) {
			expect(() => validateWorkKind(name)).toThrow(/Invalid work kind name/);
		}
		expect(() => validateWorkKind("run", { delivery: "later" })).toThrow(/delivery/);
		expect(() => validateWorkKind("run", { cancellable: "yes" })).toThrow(/cancellable/);
		expect(() => validateWorkKind("run", { cancelOnAbort: true })).toThrow(/cancelOnAbort/);
		for (const maxActive of [0, EXTENSION_KIND_MAX_ACTIVE + 1, 1.5]) {
			expect(() => validateWorkKind("run", { maxActive })).toThrow(/maxActive/);
		}
		expect(() => validateWorkKind("run", { requires: ["root.v1"] })).toThrow(/requires/);
		expect(() => validateWorkKind("run", null)).toThrow(/object/);
	});

	it("registers kinds under their extension's manifest id, refusing reserved and invalid ids", async () => {
		const { registry, kinds } = await setup();
		const refusals = kinds.bind([
			declared(SWARM, "run"),
			declared(OTHER, "run"),
			declared("volt", "run"),
			declared("Not An Id", "run"),
		]);
		expect(refusals).toEqual([
			{ extensionId: "volt", error: expect.stringContaining("Invalid work kind") },
			{ extensionId: "Not An Id", error: expect.stringContaining("Invalid work kind") },
		]);
		// A refusal is reported once.
		expect(kinds.sync([declared("volt", "run")])).toEqual([]);
		const { workId } = await kinds.start(SWARM, "run", { title: "Swarm" }, async () => ({ outcome: "completed" }));
		const other = await kinds.start(OTHER, "run", { title: "Other" }, async () => ({ outcome: "completed" }));
		await registry.waitForIdle();
		expect(registry.get(workId)?.kind).toBe("ext:swarm-review/run");
		expect(registry.get(other.workId)?.kind).toBe("ext:other/run");
	});

	it("starts only the kinds of the extension a context belongs to", async () => {
		const { kinds } = await setup();
		kinds.bind([declared(SWARM, "run")]);
		const run = vi.fn(async (): Promise<WorkRunResult> => ({ outcome: "completed" }));
		await expect(kinds.start(OTHER, "run", { title: "Not mine" }, run)).rejects.toThrow(/Unknown work kind "run"/);
		await expect(kinds.start(OTHER, "ext:swarm-review/run", { title: "Spelled" }, run)).rejects.toThrow(
			/Unknown work kind/,
		);
		await expect(kinds.start(undefined, "run", { title: "Nobody's" }, run)).rejects.toThrow(/own handlers/);
		await expect(kinds.start(SWARM, "job", { title: "Built-in" }, run)).rejects.toThrow(/Unknown work kind/);
		await expect(kinds.start(SWARM, "run", { title: 42 } as never, run)).rejects.toThrow(/title/);
		await expect(
			kinds.start(SWARM, "run", { title: "Bad input", input: { at: new Date() } as never }, run),
		).rejects.toThrow(/JSON-compatible/);
		expect(run).not.toHaveBeenCalled();
	});

	it("hands the run a narrowed context and keeps only the result parts extension work may give", async () => {
		const { conversation, registry, kinds } = await setup();
		kinds.bind([declared(SWARM, "run", { delivery: "message" })]);
		let reporter: WorkRunContext | undefined;
		const { workId } = await kinds.start(SWARM, "run", { title: "Swarm", input: { waves: 3 } }, async (ctx) => {
			reporter = ctx;
			ctx.output("found 2\n");
			return {
				outcome: "completed",
				result: {
					summary: "2 findings",
					data: { findings: 2 },
					child: { conversation: "someone-else" },
				} as WorkRunResult["result"],
				notice: "Swarm report: 2 findings",
			};
		});
		await registry.waitForIdle();
		expect(Object.keys(reporter ?? {}).sort()).toEqual(["checkpoint", "output", "progress", "signal", "workId"]);
		expect(Object.isFrozen(reporter)).toBe(true);
		const record = registry.get(workId);
		expect(record).toMatchObject({ title: "Swarm", input: { waves: 3 }, outcome: "completed" });
		expect(record?.result).toEqual({
			summary: "2 findings",
			output: { text: "found 2\n", truncated: false },
			data: { findings: 2 },
		});
		expect(conversation.queue.steer).toEqual([
			expect.objectContaining({
				content: `Swarm (ext:swarm-review/run ${workId}) completed.\nSwarm report: 2 findings`,
			}),
		]);
	});

	it("sanitizes the progress live clients see", async () => {
		const { registry, kinds, live } = await setup();
		kinds.bind([declared(SWARM, "run")]);
		const run = held();
		const { workId } = await kinds.start(SWARM, "run", { title: "Swarm" }, async (ctx) => {
			ctx.progress({
				text: "Wave \u001b[31m1\u001b[0m",
				value: Number.NaN,
				max: 3,
				steps: [
					{ key: "wave-1", label: "Wave\u0007 1", status: "active" },
					{ key: "", label: "no key", status: "done" },
					{ key: "bad", label: "bad status", status: "running" as never },
				],
			});
			return await run.run(ctx);
		});
		const key = `work/${workId}`;
		await vi.waitFor(() =>
			expect(live).toContainEqual({
				type: "set",
				key,
				value: {
					kind: "work",
					workId,
					progress: { text: "Wave 1", max: 3, steps: [{ key: "wave-1", label: "Wave 1", status: "active" }] },
				},
			}),
		);
		run.release();
		await registry.waitForIdle();
	});

	it("clearing the kinds interrupts their work and refuses further starts", async () => {
		const { registry, kinds } = await setup();
		kinds.bind([declared(SWARM, "run")]);
		const run = held();
		const { workId } = await kinds.start(SWARM, "run", { title: "Swarm" }, run.run);
		await kinds.clear();
		expect(registry.get(workId)?.outcome).toBe("interrupted");
		await expect(kinds.start(SWARM, "run", { title: "Again" }, run.run)).rejects.toThrow(/Unknown work kind/);
		// The next generation registers the same kind again.
		expect(kinds.bind([declared(SWARM, "run")])).toEqual([]);
		const next = await kinds.start(SWARM, "run", { title: "Next" }, async () => ({ outcome: "completed" }));
		await registry.waitForIdle();
		expect(registry.get(next.workId)?.outcome).toBe("completed");
	});
});
