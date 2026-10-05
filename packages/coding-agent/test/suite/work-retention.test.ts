/**
 * The single retention check (RFC §7.3): a hosted conversation is active
 * while an operation holds it, work runs with a live executor, or an
 * operation holds it open (`whileOpen`). Suspended work and work awaiting
 * approval keep nothing alive. A client may not leave an active
 * conversation.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { WorkExecution, WorkExecutor, WorkKindDefinition } from "../../src/core/work/registry.ts";
import { createHostHarness, type HostHarness, moved } from "./host-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

async function harnessFor(): Promise<HostHarness> {
	const harness = await createHostHarness({ whenUnattached: "keep" });
	cleanups.push(() => harness.cleanup());
	return harness;
}

function kind(overrides: Partial<WorkKindDefinition> = {}): WorkKindDefinition {
	return {
		kind: "ext:test/run",
		delivery: "none",
		cancellable: true,
		maxActive: 4,
		title: () => "Test work",
		...overrides,
	};
}

function held(): { execute: WorkExecutor; release(execution?: WorkExecution): void } {
	const release = Promise.withResolvers<WorkExecution>();
	return {
		execute: async (ctx) => {
			ctx.signal.addEventListener("abort", () => release.resolve({ outcome: "cancelled" }), { once: true });
			return await release.promise;
		},
		release: (execution = { outcome: "completed" }) => release.resolve(execution),
	};
}

describe("the single retention check", () => {
	it("is active while work runs or a hold is pending, and idle again once both settled", async () => {
		const harness = await harnessFor();
		const conversation = await harness.openStartup();
		conversation.work.register(kind());
		expect(conversation.isActive()).toBe(false);

		const running = held();
		await conversation.work.start("ext:test/run", null, running.execute);
		expect(conversation.isActive()).toBe(true);
		expect(() => conversation.assertCanLeave()).toThrow("Cannot change sessions while work runs");
		let idle = false;
		const waiting = conversation.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);
		running.release();
		await waiting;
		expect(conversation.isActive()).toBe(false);
		expect(() => conversation.assertCanLeave()).not.toThrow();

		// A pending operation that holds the conversation open is activity too (a review discussion start).
		const hold = Promise.withResolvers<void>();
		const held_ = conversation.whileOpen(() => hold.promise);
		expect(conversation.isActive()).toBe(true);
		expect(() => conversation.assertCanLeave()).toThrow("Cannot change sessions while work runs");
		const settled = conversation.waitForIdle();
		hold.resolve();
		await held_;
		await settled;
		expect(conversation.isActive()).toBe(false);
	});

	it("keeps nothing alive for work awaiting approval or suspended work", async () => {
		const harness = await harnessFor();
		const first = await harness.openStartup();
		const resumable = kind({ kind: "subagent", resume: () => async () => ({ outcome: "completed" }) });
		first.work.register(kind({ kind: "ext:test/approve", approval: true }));
		first.work.register(resumable);
		const approval = held();
		const action = await first.work.start("ext:test/approve", null, approval.execute);
		expect(first.work.get(action.workId)?.state).toBe("awaiting_approval");
		// An approval nobody may answer must not pin the conversation; its own timeout ends it.
		expect(first.isActive()).toBe(false);
		expect(() => first.assertCanLeave()).not.toThrow();
		await first.waitForIdle();
		await first.work.approve(action.workId);
		expect(first.isActive()).toBe(true);
		approval.release();
		await first.work.waitForIdle();
		expect(first.isActive()).toBe(false);

		const child = await first.work.start("subagent", null, held().execute);
		expect(first.isActive()).toBe(true);
		const ref = first.session.sessionRef;
		if (!ref) throw new Error("Expected a stored session");
		await harness.host.close(first);
		const reopened = await harness.host.open({ kind: "session", ref });
		if (reopened.cancelled) throw new Error("Expected the conversation to reopen");
		const second = reopened.conversation;
		second.work.register(resumable);
		const record = second.work.get(child.workId);
		if (!record) throw new Error("Expected the suspended subagent");
		expect(second.work.suspended(record)).toBe(true);
		// Suspended work holds no retention and no client in place (amendment A1).
		expect(second.isActive()).toBe(false);
		expect(() => second.assertCanLeave()).not.toThrow();
	});

	it("refuses a client leaving while work runs, and lets it leave once the work finished", async () => {
		const harness = await harnessFor();
		const source = await harness.openStartup();
		const client = harness.client("tui", { anchor: true });
		await harness.host.attach(client, source);
		source.work.register(kind());
		const running = held();
		await source.work.start("ext:test/run", null, running.execute);
		await expect(harness.host.openFor(client, { kind: "new" })).rejects.toThrow(
			"Cannot change sessions while work runs",
		);
		expect(harness.host.conversationOf(client)).toBe(source);
		running.release();
		await source.waitForIdle();
		const result = moved(await harness.host.openFor(client, { kind: "new" }));
		expect(harness.host.conversationOf(client)).toBe(result.conversation);
	});
});
