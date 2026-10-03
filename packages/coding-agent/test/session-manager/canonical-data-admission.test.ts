import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

const cleanups: Array<{ manager: SessionManager; root: string }> = [];
const managerOwner = createSessionManagerTestOwner();

async function createManager(): Promise<{ manager: SessionManager; root: string; ref: SessionReference }> {
	const root = mkdtempSync(join(tmpdir(), "volt-canonical-session-"));
	const manager = await SessionManager.create(root, root);
	const ref = manager.getSessionRef();
	if (!ref) throw new Error("Expected a persisted session reference");
	cleanups.push({ manager, root });
	return { manager, root, ref };
}

beforeEach(() => managerOwner.start());

afterEach(async () => {
	await managerOwner.drain();
	for (const { root } of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SessionManager canonical data admission", () => {
	it("rejects invalid values before state, persistence, ordinals, or observers change", async () => {
		const { manager, ref } = await createManager();
		const observed: string[] = [];
		manager.subscribeEntries((entry) => observed.push(entry.id));
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;

		for (const [label, data] of [
			["cycle", cyclic],
			["map", { value: new Map([["key", "value"]]) }],
			["undefined", { value: undefined }],
			["shared-memory", { value: new SharedArrayBuffer(1) }],
		] as const) {
			await expect(manager.appendCustomEntry(label, data as never)).rejects.toThrow(
				"Session custom entry must contain only JSON-compatible data",
			);
			expect(manager.getEntries()).toEqual([]);
			expect(manager.getLeafId()).toBeNull();
			expect(observed).toEqual([]);
		}

		const id = await manager.appendCustomEntry("valid", { nested: { values: [1, "two", true, null] } });
		expect(manager.getEntry(id)?.ordinal).toBe(1);
		expect(observed).toEqual([id]);
		expect((await SessionManager.openReadOnly(ref)).getEntries()).toHaveLength(1);
	});

	it("rejects out-of-range message timestamps before state or persistence changes", async () => {
		const { manager, ref } = await createManager();
		const observed: string[] = [];
		manager.subscribeEntries((entry) => observed.push(entry.id));
		const before = manager.issueCanonicalProjection();

		await expect(
			manager.appendMessage({
				role: "user",
				content: "outside the upper Date boundary",
				timestamp: Number.MAX_SAFE_INTEGER,
			}),
		).rejects.toThrow("Session message timestamp must be representable as a Date");
		await expect(
			manager.appendMessage({
				role: "toolResult",
				toolCallId: "invalid-timestamp",
				toolName: "test",
				content: [{ type: "text", text: "outside the lower Date boundary" }],
				isError: false,
				timestamp: -Number.MAX_SAFE_INTEGER,
			}),
		).rejects.toThrow("Session message timestamp must be representable as a Date");

		const after = manager.issueCanonicalProjection();
		expect(after.leafEntryOrdinal).toBe(before.leafEntryOrdinal);
		expect(after.entries).toEqual([]);
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		expect(observed).toEqual([]);

		const persistedBeforeValidAppend = await SessionManager.openReadOnly(ref);
		expect(persistedBeforeValidAppend.getEntries()).toEqual([]);
		expect(persistedBeforeValidAppend.getLeafId()).toBeNull();

		const validUserId = await manager.appendMessage({
			role: "user",
			content: "exact upper Date boundary",
			timestamp: 8_640_000_000_000_000,
		});
		const validToolResultId = await manager.appendMessage({
			role: "toolResult",
			toolCallId: "valid-timestamp",
			toolName: "test",
			content: [{ type: "text", text: "exact lower Date boundary" }],
			isError: false,
			timestamp: -8_640_000_000_000_000,
		});

		expect(manager.getEntry(validUserId)?.ordinal).toBe(1);
		expect(manager.getEntry(validToolResultId)?.ordinal).toBe(2);
		expect(observed).toEqual([validUserId, validToolResultId]);
		const persisted = await SessionManager.openReadOnly(ref);
		expect(persisted.getEntries().map((entry) => entry.id)).toEqual([validUserId, validToolResultId]);
		expect(persisted.getLeafId()).toBe(validToolResultId);
	});

	it("rejects malformed entry bodies before assigning ordinals or notifying observers", async () => {
		const { manager } = await createManager();
		const observed: string[] = [];
		manager.subscribeEntries((entry) => observed.push(entry.id));

		await expect(
			manager.appendMessage({
				role: "user",
				content: "unknown field",
				timestamp: Date.now(),
				unexpected: true,
			} as never),
		).rejects.toThrow("unknown property");
		await expect(manager.appendThinkingLevelChange("turbo" as never)).rejects.toThrow("invalid thinking level");
		await expect(manager.appendFastModeChange("yes" as never)).rejects.toThrow("invalid enabled state");
		await expect(manager.appendModelChange("", "model")).rejects.toThrow("must not be empty");
		await expect(
			manager.appendCustomMessageEntry("custom", [{ type: "video", data: "nope" }] as never, true),
		).rejects.toThrow("unsupported user content type");
		await expect(
			manager.appendSubagentSpawn({
				toolCallId: "call-1",
				subagentId: "sa_child",
				agent: "researcher",
				childSessionId: "child-session",
				childSessionRef: {
					sessionDirectory: "/sessions",
					storeId: "store",
					sessionId: "other-child",
					sessionGeneration: "generation",
				},
				requestKey: "request-1",
			}),
		).rejects.toThrow("must match childSessionId");

		expect(manager.getEntries()).toEqual([]);
		expect(manager.getSubagentSpawnEntries()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		expect(observed).toEqual([]);
		const validId = await manager.appendSessionInfo("valid");
		expect(manager.getEntry(validId)?.ordinal).toBe(1);
	});

	it("bounds client input errors to a codec-valid terminal entry", async () => {
		const { manager, ref } = await createManager();
		await manager.reserveClientInput("long-error", "prompt", { message: "fail" });

		const failed = await manager.transitionClientInput("long-error", "failed", "x".repeat(2_001));
		expect(Array.from(failed.error ?? "")).toHaveLength(2_000);
		expect(failed.error?.endsWith("…")).toBe(true);

		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getClientInput("long-error")?.error).toBe(failed.error);
	});

	it("owns valid input and round-trips it exactly through SQLite reopen", async () => {
		const { manager, ref } = await createManager();
		const data = { nested: { values: [1, "two", true, null] } };
		const expected = structuredClone(data);
		manager.subscribeEntries((entry) => {
			if (entry.type !== "custom") return;
			(entry.data as { nested: { values: unknown[] } }).nested.values[0] = "observer mutation";
		});
		const appended = manager.appendCustomEntry("valid", data);
		const materialized = manager.appendCustomMessageEntry("flush", "materialize session", true);
		data.nested.values[0] = 99;

		const id = await appended;
		await materialized;
		const inMemory = manager.getEntry(id);
		expect(inMemory?.type).toBe("custom");
		if (inMemory?.type !== "custom") throw new Error("Expected custom entry");
		expect(inMemory.data).toEqual(expected);

		const persisted = (await SessionManager.openReadOnly(ref)).getEntry(id);
		expect(persisted?.type).toBe("custom");
		if (persisted?.type !== "custom") throw new Error("Expected reopened custom entry");
		expect(persisted.data).toEqual(expected);
	});

	it("prevalidates branch summaries before moving the active leaf", async () => {
		const { manager } = await createManager();
		const firstId = await manager.appendCustomMessageEntry("first", "first", true);
		const secondId = await manager.appendCustomMessageEntry("second", "second", true);
		expect(manager.getLeafId()).toBe(secondId);

		await expect(
			manager.branchWithSummary(firstId, "summary", { shared: new SharedArrayBuffer(1) } as never),
		).rejects.toThrow("Session branch_summary entry must contain only JSON-compatible data");
		expect(manager.getLeafId()).toBe(secondId);
		expect(manager.getEntries().map((entry) => entry.id)).toEqual([firstId, secondId]);
	});
});
