/**
 * The settings a daemon-hosted conversation runs with, read where its
 * resources are read and applied to the process's HTTP stack as it starts.
 * The extension inventory reads them the same way, so it loads what a
 * conversation would.
 */

import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { SettingsManager } from "../../core/settings-manager.ts";

/** The settings of a conversation whose project resources are read in `cwd`, with their HTTP options applied. */
export function createConversationSettings(
	cwd: string,
	agentDir: string,
	options: { readonly profile: string | undefined; readonly projectTrusted: boolean },
): SettingsManager {
	const settingsManager = SettingsManager.create(cwd, agentDir, {
		profile: options.profile,
		projectTrusted: options.projectTrusted,
	});
	applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
	return settingsManager;
}
