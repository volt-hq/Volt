import { describe, expect, it } from "vitest";
import { ExtensionHandlerRegistry } from "../src/core/extensions/policy-registration.ts";

function invoke(registry: ExtensionHandlerRegistry, event = "tool_call") {
	return registry.get(event)?.map((handler) => handler());
}

describe("owned extension tool-policy registrations", () => {
	it("owns initial lists and returns immutable snapshots", () => {
		const original = () => "original";
		const handlers = [original];
		const registry = new ExtensionHandlerRegistry([["tool_call", handlers]]);
		handlers[0] = () => "replaced";
		handlers.push(() => "injected");
		expect(invoke(registry)).toEqual(["original"]);
		expect(Object.isFrozen(registry.get("tool_call"))).toBe(true);
	});

	it.each(["tool_call", "tool_result"])(
		"versions every %s update, restoration, invalidation, and removal",
		(event) => {
			const registry = new ExtensionHandlerRegistry();
			const original = () => "original";
			const revision = registry.authorizationRevision;
			const registration = registry.register(event, original);
			expect(registry.authorizationRevision).toBe(revision + 1n);
			registration.update(() => "replacement");
			expect(invoke(registry, event)).toEqual(["replacement"]);
			registration.update(original);
			expect(invoke(registry, event)).toEqual(["original"]);
			registration.invalidate();
			expect(registry.authorizationRevision).toBe(revision + 4n);
			registration();
			expect(registry.has(event)).toBe(false);
			expect(registry.authorizationRevision).toBe(revision + 5n);
			registration();
			expect(registry.authorizationRevision).toBe(revision + 5n);
			expect(() => registration.update(original)).toThrow("removed");
			expect(() => registration.invalidate()).toThrow("removed");
		},
	);

	it("preserves registration order and independent ownership of duplicate callbacks", () => {
		const registry = new ExtensionHandlerRegistry();
		const same = () => "same";
		const first = registry.register("tool_call", same);
		const second = registry.register("tool_call", same);
		const third = registry.register("tool_call", () => "third");
		second.update(() => "second");
		expect(invoke(registry)).toEqual(["same", "second", "third"]);
		first();
		expect(invoke(registry)).toEqual(["second", "third"]);
		third();
		expect(invoke(registry)).toEqual(["second"]);
	});

	it("does not revoke tool authorization for observational handlers", () => {
		const registry = new ExtensionHandlerRegistry();
		const observer = registry.register("extension_operation", () => {});
		observer.update(() => {});
		observer.invalidate();
		observer();
		expect(registry.authorizationRevision).toBe(0n);
	});

	it("rejects retained registration handles from a retired extension runtime", () => {
		const registry = new ExtensionHandlerRegistry();
		let stale = false;
		const registration = registry.register(
			"tool_call",
			() => "original",
			() => {
				if (stale) throw new Error("stale runtime");
			},
		);
		stale = true;
		expect(() => registration.update(() => "replacement")).toThrow("stale runtime");
		expect(() => registration.invalidate()).toThrow("stale runtime");
		expect(() => registration()).toThrow("stale runtime");
		expect(registry.authorizationRevision).toBe(1n);
		expect(invoke(registry)).toEqual(["original"]);
	});
});
