import { afterEach, describe, expect, it, vi } from "vitest";
import {
	SubagentDelegationScope,
	type SubagentDelegationScopeOptions,
} from "../src/core/subagents/delegation-scope.ts";

const scopes: SubagentDelegationScope[] = [];
const maximumDurationMs = 2_147_483_647;

function createScope(options: SubagentDelegationScopeOptions): SubagentDelegationScope {
	const scope = new SubagentDelegationScope(options);
	scopes.push(scope);
	return scope;
}

afterEach(() => {
	for (const scope of scopes.splice(0).reverse()) scope.dispose();
	vi.useRealTimers();
});

describe("subagent delegation deadlines", () => {
	it.each([maximumDurationMs + 1, 2_592_000_000, Number.MAX_VALUE])(
		"rejects the overflowing finite duration %s before scheduling a deadline",
		(maxDurationMs) => {
			expect(() => createScope({ limits: { maxDurationMs } })).toThrow(
				"Subagent delegation limit maxDurationMs must be at most 2147483647ms or Infinity",
			);
		},
	);

	it("accepts the maximum finite duration and aborts only at its deadline", () => {
		vi.useFakeTimers();
		const scope = createScope({ limits: { maxDurationMs: maximumDurationMs } });

		vi.advanceTimersByTime(maximumDurationMs - 1);
		expect(scope.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(scope.signal.aborted).toBe(true);
		expect(scope.signal.reason).toBeInstanceOf(Error);
		expect(scope.signal.reason.message).toContain("2147483647ms deadline");
	});

	it("keeps Infinity unlimited", () => {
		vi.useFakeTimers();
		const scope = createScope({ limits: { maxDurationMs: Number.POSITIVE_INFINITY } });

		vi.advanceTimersByTime(maximumDurationMs * 2);
		expect(scope.signal.aborted).toBe(false);
	});

	it("keeps an unlimited child within its parent's finite deadline", () => {
		vi.useFakeTimers();
		const parent = createScope({ limits: { maxDurationMs: 100 } });
		const child = createScope({ parent, limits: { maxDurationMs: Number.POSITIVE_INFINITY } });

		expect(child.limits.maxDurationMs).toBe(100);
		vi.advanceTimersByTime(99);
		expect(child.signal.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(parent.signal.aborted).toBe(true);
		expect(child.signal.aborted).toBe(true);
	});

	it("rejects an overflowing duration even under a shorter parent deadline", () => {
		const parent = createScope({ limits: { maxDurationMs: 100 } });

		expect(() => createScope({ parent, limits: { maxDurationMs: maximumDurationMs + 1 } })).toThrow(
			"Subagent delegation limit maxDurationMs must be at most 2147483647ms or Infinity",
		);
	});
});
