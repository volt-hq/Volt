/**
 * What a worker's conversation watches (Phase 7 plan §1, D12): settings and
 * credentials other processes write reach the conversations a worker hosts.
 * A change to the global or the project `settings.json` reloads the
 * conversation's settings (its extensions see `settings_changed` when theirs
 * changed) and tells its clients to refetch them; a change to `auth.json` or
 * `models.json` reloads its credentials and models, and tells its clients
 * when the available models changed, so a `/login` in one worker reaches the
 * others. A directory that cannot be watched is not, and its file is still
 * read on the next reload.
 *
 * A project trusted when the conversation opened because it held nothing
 * that needs trust is not trusted for what was written into it since: while
 * the project would not be trusted now, its settings are not reloaded (the
 * conversation keeps those it has until it opens again).
 */

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { HostedConversation } from "../../core/host/hosted-conversation.ts";
import { startModelCatalogWatcher } from "../../core/model-catalog-watcher.ts";

const SETTINGS_FILE_NAME = "settings.json";
const SETTINGS_DEBOUNCE_MS = 300;

/** Watch `directory` for its `settings.json`; undefined when it cannot be watched. */
function watchSettingsFile(directory: string, onChange: () => void): FSWatcher | undefined {
	try {
		const watcher = watch(directory, (eventType, fileName) => {
			// A rename may name only the temporary file of an atomic replace, or nothing.
			if (eventType === "rename" || fileName === null || fileName === SETTINGS_FILE_NAME) onChange();
		});
		watcher.on("error", () => watcher.close());
		watcher.unref?.();
		return watcher;
	} catch {
		return undefined;
	}
}

/**
 * Watch the settings and credentials of `conversation` until the returned
 * stop runs; `onChanged` hears which catalog its clients refetch.
 */
export function watchConversationSettings(
	conversation: HostedConversation,
	onChanged: (catalog: "settings" | "models") => void,
	/** Whether the project in `cwd` is trusted now. */
	projectTrusted: (cwd: string) => boolean,
): () => void {
	const { agentDir, projectCwd } = conversation.services;
	const stopCatalog = startModelCatalogWatcher({
		agentDir,
		getModelRegistry: () => conversation.session.modelRegistry,
		onCatalogChanged: () => onChanged("models"),
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	let withheld = false;
	const reload = (): void => {
		timer = undefined;
		if (stopped || conversation.closed) return;
		const settings = conversation.session.settingsManager;
		if (settings.isProjectTrusted() && !projectTrusted(projectCwd)) {
			if (!withheld) {
				withheld = true;
				console.error(
					`worker: ${conversation.id}: the project now holds resources that need trust; its settings are not reloaded`,
				);
			}
			return;
		}
		void settings.reload().then(
			() => {
				if (!stopped) onChanged("settings");
			},
			() => undefined,
		);
	};
	const schedule = (): void => {
		if (stopped) return;
		clearTimeout(timer);
		timer = setTimeout(reload, SETTINGS_DEBOUNCE_MS);
		timer.unref?.();
	};
	const watchers = [agentDir, join(projectCwd, CONFIG_DIR_NAME)]
		.map((directory) => watchSettingsFile(directory, schedule))
		.filter((watcher) => watcher !== undefined);
	return () => {
		if (stopped) return;
		stopped = true;
		clearTimeout(timer);
		stopCatalog();
		for (const watcher of watchers) watcher.close();
	};
}
