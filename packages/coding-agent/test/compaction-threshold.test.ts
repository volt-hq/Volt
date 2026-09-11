import { describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/compaction.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";

const model = { provider: "openai-codex", id: "gpt-6-astra" };
const reference = `${model.provider}/${model.id}`;

describe("per-model compaction thresholds", () => {
	it("triggers at the configured count without changing context or summarization budgets", () => {
		const manager = SettingsManager.inMemory();
		manager.setCompactionThresholdTokens(reference, 350_000);
		const settings = manager.getCompactionSettings(model);
		expect(settings).toEqual({ ...DEFAULT_COMPACTION_SETTINGS, thresholdTokens: 350_000 });
		expect(shouldCompact(349_999, 1_000_000, settings)).toBe(false);
		expect(shouldCompact(350_000, 1_000_000, settings)).toBe(true);
		expect(shouldCompact(350_001, 1_000_000, settings)).toBe(true);
		expect(shouldCompact(350_000, 1_000_000, { ...settings, enabled: false })).toBe(false);
	});

	it("retains the context-limit trigger even when the custom count exceeds it", () => {
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, thresholdTokens: 350_000 };
		expect(shouldCompact(200_000 - settings.reserveTokens, 200_000, settings)).toBe(false);
		expect(shouldCompact(200_000 - settings.reserveTokens + 1, 200_000, settings)).toBe(true);
	});

	it("persists exact provider/model matching, reset, and independent warning settings", async () => {
		const manager = SettingsManager.inMemory({ warnings: { contextTokens: 250_000 } });
		manager.setCompactionThresholdTokens(reference, 350_000);
		manager.setCompactionThresholdTokens("openai/gpt-6-astra", 500_000);
		await manager.reload();
		expect(manager.getCompactionThresholdTokens(reference)).toBe(350_000);
		expect(manager.getCompactionThresholdTokens("openai/gpt-6-astra")).toBe(500_000);
		expect(manager.getCompactionThresholdTokens("openai-codex/other")).toBe(0);
		expect(manager.getContextWarningTokens()).toBe(250_000);
		manager.setCompactionThresholdTokens(reference, 0);
		await manager.reload();
		expect(shouldCompact(350_000, 1_000_000, manager.getCompactionSettings(model))).toBe(false);
		expect(manager.getCompactionThresholdTokens("openai/gpt-6-astra")).toBe(500_000);
		expect(manager.getCompactionEnabled()).toBe(true);
	});

	it("merges profile and trusted project overrides without copying inherited model entries", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () =>
			JSON.stringify({
				compaction: { modelThresholds: { [reference]: 350_000, "openai/other": 150_000 } },
				profiles: { work: { compaction: { modelThresholds: { [reference]: 250_000 } } } },
			}),
		);
		storage.withLock("project", () =>
			JSON.stringify({
				compaction: { modelThresholds: { [reference]: 200_000 } },
				profiles: { work: { compaction: { modelThresholds: { [reference]: 100_000 } } } },
			}),
		);
		const manager = SettingsManager.fromStorage(storage, { profile: "work" });
		expect(manager.getCompactionThresholdTokens(reference)).toBe(100_000);
		expect(manager.getCompactionThresholdTokens("openai/other")).toBe(150_000);
		manager.setProjectTrusted(false);
		expect(manager.getCompactionThresholdTokens(reference)).toBe(250_000);
		manager.setCompactionThresholdTokens(reference, 0);
		await manager.reload();
		expect(manager.getCompactionThresholdTokens(reference)).toBe(0);
		expect(manager.getGlobalSettings().profiles?.work?.compaction?.modelThresholds).toEqual({ [reference]: 0 });
		manager.setActiveProfile(undefined);
		expect(manager.getCompactionThresholdTokens(reference)).toBe(350_000);
	});

	it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid setter value %s", (value) => {
		const manager = SettingsManager.inMemory();
		expect(() => manager.setCompactionThresholdTokens(reference, value)).toThrow("non-negative safe integer");
		expect(manager.getCompactionThresholdTokens(reference)).toBe(0);
	});

	it.each([-1, 0, 1.5, "350000", null, {}, [], Number.MAX_SAFE_INTEGER + 1])(
		"ignores invalid or default JSON threshold %j without disabling safety compaction",
		(value) => {
			const storage = new InMemorySettingsStorage();
			storage.withLock("global", () => JSON.stringify({ compaction: { modelThresholds: { [reference]: value } } }));
			const manager = SettingsManager.fromStorage(storage);
			expect(manager.getCompactionThresholdTokens(reference)).toBe(0);
			expect(shouldCompact(350_000, 1_000_000, manager.getCompactionSettings(model))).toBe(false);
			expect(shouldCompact(990_000, 1_000_000, manager.getCompactionSettings(model))).toBe(true);
		},
	);
});
