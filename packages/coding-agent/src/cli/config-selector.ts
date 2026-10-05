/**
 * TUI config selector for `volt config` command
 */

import { ProcessTerminal, TuiMainScreen } from "@hansjm10/volt-tui";
import { type DeclaredExtension, readDeclaredExtension } from "../core/extensions/loader.ts";
import { declaresPackageExtension } from "../core/extensions/manifest.ts";
import { ExtensionPermissionStore } from "../core/extensions/permissions.ts";
import { extensionSettingsView, storeExtensionSettings } from "../core/extensions/settings.ts";
import type { ResolvedPaths } from "../core/package-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { initTheme, stopThemeWatcher } from "../core/theme/runtime.ts";
import { ConfigSelectorComponent } from "../modes/interactive/components/config-selector.ts";
import { ExtensionSettingsComponent, extensionDetail } from "../modes/interactive/components/extension-settings.ts";
import { isLocalPath } from "../utils/paths.ts";

export interface ConfigSelectorOptions {
	resolvedPaths: ResolvedPaths;
	settingsManager: SettingsManager;
	cwd: string;
	agentDir: string;
}

/**
 * What the resolved extensions declare, by path, as loading reads it. A
 * package's manifest is read from package.json, enabled or not; a single-file
 * extension's module is evaluated only when it is enabled. One without a
 * valid manifest is left out.
 */
async function readDeclaredExtensions(resolved: ResolvedPaths, cwd: string): Promise<Map<string, DeclaredExtension>> {
	const declared = new Map<string, DeclaredExtension>();
	for (const { path, enabled, metadata } of resolved.extensions) {
		if (!enabled && !declaresPackageExtension(path)) continue;
		try {
			declared.set(
				path,
				await readDeclaredExtension(
					{
						path,
						scope: metadata.scope,
						installed: metadata.origin === "package" && !isLocalPath(metadata.source),
						...(metadata.origin === "package" ? { packageSource: metadata.source } : {}),
					},
					cwd,
				),
			);
		} catch {
			// Loading reports an invalid manifest; its row has no settings here.
		}
	}
	return declared;
}

/** Show TUI config selector and return when closed */
export async function selectConfig(options: ConfigSelectorOptions): Promise<void> {
	// Initialize theme before showing TUI
	initTheme(options.settingsManager.getTheme(), true);
	const declared = await readDeclaredExtensions(options.resolvedPaths, options.cwd);
	const permissionStore = new ExtensionPermissionStore(options.agentDir);
	const { settingsManager } = options;

	return new Promise((resolve) => {
		const ui = new TuiMainScreen(new ProcessTerminal());
		let resolved = false;

		const selector: ConfigSelectorComponent = new ConfigSelectorComponent(
			options.resolvedPaths,
			settingsManager,
			options.cwd,
			options.agentDir,
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					stopThemeWatcher();
					resolve();
				}
			},
			() => {
				ui.stop();
				stopThemeWatcher();
				process.exit(0);
			},
			() => ui.requestRender(),
			ui.terminal.rows,
			{
				declared,
				onOpenSettings: (extension) => {
					const { id, settings } = extension.manifest;
					const view = new ExtensionSettingsComponent(
						extensionDetail(extension, permissionStore),
						{
							load: async () => extensionSettingsView(settingsManager, id, settings),
							save: (scope, values) => storeExtensionSettings(settingsManager, id, settings, scope, values),
						},
						{
							onClose: () => {
								ui.removeChild(view);
								ui.addChild(selector);
								ui.setFocus(selector.getResourceList());
								ui.requestRender();
							},
							requestRender: () => ui.requestRender(),
						},
					);
					ui.removeChild(selector);
					ui.addChild(view);
					ui.setFocus(view);
					void view.start();
					ui.requestRender();
				},
			},
		);

		ui.addChild(selector);
		ui.setFocus(selector.getResourceList());
		ui.start();
	});
}
