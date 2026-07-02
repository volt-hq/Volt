/**
 * Watches the agent dir's auth.json and models.json so long-running hosts pick up
 * logins, logouts, and API keys saved by other volt processes without a restart.
 *
 * On a relevant file change the watcher reloads credentials and models from disk
 * and invokes onCatalogChanged only when the set of available models actually
 * changed, so OAuth token refresh rewrites do not produce spurious notifications.
 */

import { type FSWatcher, watch } from "node:fs";
import type { ModelRegistry } from "./model-registry.ts";

const WATCHED_FILE_NAMES = new Set(["auth.json", "models.json"]);
const CHANGE_DEBOUNCE_MS = 300;

export interface ModelCatalogWatcherOptions {
	/** Directory containing auth.json and models.json. Watching is skipped when undefined. */
	agentDir: string | undefined;
	getModelRegistry: () => ModelRegistry;
	/** Called after a disk refresh that changed the available model catalog. */
	onCatalogChanged: () => void;
	debounceMs?: number;
}

export function getModelCatalogSignature(modelRegistry: ModelRegistry): string {
	return modelRegistry
		.getAvailable()
		.map((model) => `${model.provider}/${model.id}`)
		.sort()
		.join("\n");
}

/**
 * Start watching the agent dir for credential/model config changes.
 * Returns a stop function. Watch failures degrade to a no-op watcher: clients
 * still get fresh catalogs from get_available_models' explicit disk refresh.
 */
export function startModelCatalogWatcher(options: ModelCatalogWatcherOptions): () => void {
	if (!options.agentDir) {
		return () => {};
	}

	let watcher: FSWatcher | undefined;
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let stopped = false;
	const debounceMs = options.debounceMs ?? CHANGE_DEBOUNCE_MS;

	const stop = (): void => {
		if (stopped) {
			return;
		}
		stopped = true;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
		watcher?.close();
		watcher = undefined;
	};

	let lastCatalogSignature: string;
	try {
		lastCatalogSignature = getModelCatalogSignature(options.getModelRegistry());
	} catch {
		return () => {};
	}

	const handleCatalogSourceChange = (): void => {
		debounceTimer = undefined;
		if (stopped) {
			return;
		}
		try {
			const modelRegistry = options.getModelRegistry();
			modelRegistry.refreshFromDisk();
			const signature = getModelCatalogSignature(modelRegistry);
			if (signature === lastCatalogSignature) {
				return;
			}
			lastCatalogSignature = signature;
		} catch {
			return;
		}
		options.onCatalogChanged();
	};

	try {
		watcher = watch(options.agentDir, (_eventType, fileName) => {
			if (stopped || typeof fileName !== "string" || !WATCHED_FILE_NAMES.has(fileName)) {
				return;
			}
			if (debounceTimer) {
				clearTimeout(debounceTimer);
			}
			debounceTimer = setTimeout(handleCatalogSourceChange, debounceMs);
			debounceTimer.unref?.();
		});
		watcher.on("error", stop);
		watcher.unref?.();
	} catch {
		stop();
		return () => {};
	}

	return stop;
}
