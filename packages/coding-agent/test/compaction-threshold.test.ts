import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../src/core/compaction/compaction.ts";
import {
	FileSettingsStorage,
	InMemorySettingsStorage,
	type Settings,
	SettingsManager,
} from "../src/core/settings-manager.ts";

const model = { provider: "openai-codex", id: "gpt-6-astra" };
const reference = `${model.provider}/${model.id}`;
const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

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

	describe.each([
		{ scope: "global", profile: undefined },
		{ scope: "profile", profile: "work" },
	])("concurrent $scope persistence", ({ profile }) => {
		const otherReference = "openai/other";

		function setup(modelThresholds: Record<string, number> = {}) {
			const directory = mkdtempSync(join(tmpdir(), "volt-model-thresholds-"));
			temporaryDirectories.push(directory);
			const storage = new FileSettingsStorage(directory, join(directory, "agent"));
			const scopedSettings: Settings = {
				compaction: { enabled: true, reserveTokens: 1234, modelThresholds },
			};
			storage.withLock("global", () =>
				JSON.stringify(
					profile
						? {
								compaction: { modelThresholds: { "inherited/model": 600_000 } },
								profiles: { [profile]: scopedSettings },
							}
						: scopedSettings,
				),
			);
			const first = SettingsManager.fromStorage(storage, { profile });
			const second = SettingsManager.fromStorage(storage, { profile });
			return {
				storage,
				first,
				second,
				readSaved: () => {
					const saved = SettingsManager.fromStorage(storage).getGlobalSettings();
					return profile ? saved.profiles![profile] : saved;
				},
			};
		}

		const initialThresholds: Record<string, number>[] = [{}, { [reference]: 100_000, [otherReference]: 200_000 }];
		it.each(initialThresholds)(
			"preserves independent edits from stale snapshots starting with %j",
			async (initial) => {
				const { first, second, readSaved } = setup(initial);
				first.setCompactionThresholdTokens(reference, 350_000);
				first.setCompactionEnabled(false);
				await first.flush();
				second.setCompactionThresholdTokens(otherReference, 500_000);
				await second.flush();
				expect(readSaved().compaction).toEqual({
					enabled: false,
					reserveTokens: 1234,
					modelThresholds: { [reference]: 350_000, [otherReference]: 500_000 },
				});
			},
		);

		it("preserves reset-to-default entries when another session saves a different model", async () => {
			const { first, second, readSaved } = setup({ [reference]: 350_000 });
			first.setCompactionThresholdTokens(reference, 0);
			await first.flush();
			second.setCompactionThresholdTokens(otherReference, 500_000);
			await second.flush();
			expect(readSaved().compaction?.modelThresholds).toEqual({ [reference]: 0, [otherReference]: 500_000 });
		});

		it("stops replaying saved model keys and lets the last save win for the same model", async () => {
			const { first, second, readSaved } = setup();
			first.setCompactionThresholdTokens(reference, 350_000);
			await first.flush();
			second.setCompactionThresholdTokens(reference, 450_000);
			await second.flush();
			first.setCompactionThresholdTokens(otherReference, 500_000);
			await first.flush();
			expect(readSaved().compaction?.modelThresholds).toEqual({
				[reference]: 450_000,
				[otherReference]: 500_000,
			});
		});

		it("keeps queued edits isolated from later model-key tracking changes", async () => {
			const { first, second, readSaved } = setup({ [otherReference]: 200_000 });
			first.setCompactionThresholdTokens(reference, 350_000);
			second.setCompactionThresholdTokens("openai/third", 400_000);
			first.setCompactionThresholdTokens(otherReference, 500_000);
			await Promise.all([first.flush(), second.flush()]);
			expect(readSaved().compaction?.modelThresholds).toEqual({
				[reference]: 350_000,
				[otherReference]: 500_000,
				"openai/third": 400_000,
			});
		});

		it("retries only dirty model entries after a failed write", async () => {
			const { storage, second, readSaved } = setup({ [otherReference]: 200_000 });
			let failWrite = false;
			const first = SettingsManager.fromStorage(
				{
					withLock: (scope, update) => {
						storage.withLock(scope, (current) => {
							const next = update(current);
							if (failWrite && next !== undefined) throw new Error("test write failure");
							return next;
						});
					},
				},
				{ profile },
			);
			failWrite = true;
			first.setCompactionThresholdTokens(reference, 350_000);
			await expect(first.flush()).rejects.toThrow("test write failure");
			second.setCompactionThresholdTokens(otherReference, 500_000);
			await second.flush();
			failWrite = false;
			first.setTheme("light");
			await first.flush();
			expect(readSaved().compaction?.modelThresholds).toEqual({
				[reference]: 350_000,
				[otherReference]: 500_000,
			});
			expect(readSaved().theme).toBe("light");
		});
	});

	it("snapshots threshold edits separately when switching profiles before writes settle", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify({ profiles: { work: {}, personal: {} } }));
		const first = SettingsManager.fromStorage(storage);
		const second = SettingsManager.fromStorage(storage, { profile: "work" });
		first.setCompactionThresholdTokens(reference, 350_000);
		first.setActiveProfile("work");
		first.setCompactionThresholdTokens(reference, 250_000);
		second.setCompactionThresholdTokens("openai/other", 500_000);
		first.setActiveProfile("personal");
		first.setCompactionThresholdTokens(reference, 0);
		await Promise.all([first.flush(), second.flush()]);
		const saved = SettingsManager.fromStorage(storage).getGlobalSettings();
		expect(saved.compaction?.modelThresholds).toEqual({ [reference]: 350_000 });
		expect(saved.profiles?.work?.compaction?.modelThresholds).toEqual({
			[reference]: 250_000,
			"openai/other": 500_000,
		});
		expect(saved.profiles?.personal?.compaction?.modelThresholds).toEqual({ [reference]: 0 });
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
