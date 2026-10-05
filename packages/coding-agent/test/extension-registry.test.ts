/**
 * The extension registry (core/extensions/registry.ts) on its own: changes
 * queued while a reload replaces the generation still apply, and an extension
 * enabled at runtime runs only once its permissions are acknowledged.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionPermission } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createExtensionRuntime, loadExtensions } from "../src/core/extensions/loader.ts";
import { type DeclaredExtensionInfo, ExtensionRegistry } from "../src/core/extensions/registry.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ExtensionSettingsRuntime } from "../src/core/extensions/settings.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { testExtension } from "./utilities.ts";

describe("extension registry", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "volt-registry-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	interface Fixture {
		readonly registry: ExtensionRegistry;
		readonly settings: SettingsManager;
		readonly loads: string[];
		load(): Promise<LoadExtensionsResult>;
		/** Make `result` the current generation, as a reload does. */
		replace(result: LoadExtensionsResult): void;
	}

	async function fixture(
		options: {
			permissions?: ExtensionPermission[];
			acknowledged?: (extension: DeclaredExtensionInfo) => boolean;
		} = {},
	): Promise<Fixture> {
		const settings = SettingsManager.inMemory();
		const loads: string[] = [];
		const load = () =>
			loadExtensions(
				[
					{
						path: "<inline:1>",
						definition: testExtension(
							"demo",
							() => {
								loads.push("demo");
							},
							options.permissions,
						),
					},
				],
				cwd,
				undefined,
				createExtensionRuntime(new ExtensionSettingsRuntime(settings)),
			);
		const first = await load();
		let runner = new ExtensionRunner(
			first.extensions,
			first.runtime,
			cwd,
			SessionManager.inMemory(),
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		const registry = new ExtensionRegistry({
			runner: () => runner,
			enabled: (id) => settings.getExtensionEnabled(id),
			acknowledged: options.acknowledged ?? (() => true),
			bound: () => false,
			changed: () => {},
			statesChanged: () => {},
			retireDeclarations: () => {},
			retireWork: async () => {},
			turnBoundary: async () => {},
			reportError: () => {},
		});
		registry.reset(first);
		return {
			registry,
			settings,
			loads,
			load,
			replace: (result) => {
				runner = new ExtensionRunner(
					result.extensions,
					result.runtime,
					cwd,
					SessionManager.inMemory(),
					ModelRegistry.inMemory(AuthStorage.inMemory()),
				);
				registry.reset(result);
			},
		};
	}

	it("applies a change queued while a reload replaced the extensions", async () => {
		const { registry, settings, load, replace } = await fixture();
		expect(registry.get("demo")?.state).toBe("active");
		const loaded = await load();
		const reloading = Promise.withResolvers<void>();
		// The reload holds the queue; settings change meanwhile, after the reloaded extensions were loaded.
		const reload = registry.exclusive(async () => {
			await reloading.promise;
			replace(loaded);
		});
		settings.setExtensionEnabled("demo", "global", false);
		const reconciled = registry.reconcile();
		reloading.resolve();
		await reload;
		await reconciled;
		await registry.settled();
		expect(registry.get("demo")?.state).toBe("disabled");
		expect(registry.active()).toEqual([]);
	});

	it("runs an extension enabled at runtime only once its permissions are acknowledged", async () => {
		let acknowledged = false;
		const { registry, settings, loads } = await fixture({
			permissions: ["exec"],
			acknowledged: () => acknowledged,
		});
		expect(loads).toEqual(["demo"]);
		settings.setExtensionEnabled("demo", "global", false);
		await registry.reconcile();
		await registry.settled();
		expect(registry.get("demo")?.state).toBe("disabled");

		settings.setExtensionEnabled("demo", "global", true);
		await registry.reconcile();
		expect(registry.get("demo")?.state).toBe("failed");
		expect(loads).toEqual(["demo"]);

		acknowledged = true;
		await registry.retry("demo");
		expect(registry.get("demo")?.state).toBe("active");
		expect(loads).toEqual(["demo", "demo"]);
	});
});
