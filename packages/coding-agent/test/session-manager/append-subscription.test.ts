import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager entry subscriptions", () => {
	it("notifies exactly once after the appended entry is queryable", async () => {
		const session = SessionManager.inMemory();
		const observed: string[] = [];
		const unsubscribe = session.subscribeEntries((entry) => {
			expect(session.getEntry(entry.id)).toEqual(entry);
			expect(session.getBranch().at(-1)).toEqual(entry);
			observed.push(entry.id);
		});

		const first = await session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		unsubscribe();
		const second = await session.appendMessage({ role: "user", content: "second", timestamp: 2 });

		expect(observed).toEqual([first]);
		expect(session.getEntry(second)?.id).toBe(second);
	});

	it("isolates listener failures from persistence and later listeners", async () => {
		const session = SessionManager.inMemory();
		const healthy = vi.fn();
		session.subscribeEntries(() => {
			throw new Error("observer failed");
		});
		session.subscribeEntries(healthy);

		const id = await session.appendMessage({ role: "user", content: "persisted", timestamp: 1 });

		expect(session.getEntry(id)?.id).toBe(id);
		expect(healthy).toHaveBeenCalledOnce();
	});

	it("assigns monotonic commit ordinals and reports branch rebases", async () => {
		const session = SessionManager.inMemory();
		const first = await session.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const second = await session.appendMessage({ role: "user", content: "second", timestamp: 2 });
		const changes: Array<{ previousLeafId: string | null; nextLeafId: string | null }> = [];
		session.subscribeBranchChanges((change) => changes.push(change));

		await session.branch(first);
		const fork = await session.appendMessage({ role: "user", content: "fork", timestamp: 3 });

		expect(session.getEntry(first)?.ordinal).toBe(1);
		expect(session.getEntry(second)?.ordinal).toBe(2);
		expect(session.getEntry(fork)?.ordinal).toBe(4);
		expect(changes).toEqual([{ previousLeafId: second, nextLeafId: first }]);
	});
});
