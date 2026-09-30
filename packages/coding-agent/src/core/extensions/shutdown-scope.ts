import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionRuntime } from "./types.ts";

interface ShutdownScope {
	runtime: ExtensionRuntime;
	extensionPath: string;
	active: boolean;
}

const shutdownScope = new AsyncLocalStorage<ShutdownScope>();

/** Admit local resource cleanup without restoring any session or host capabilities. */
export function withShutdownCleanupScope<T>(
	runtime: ExtensionRuntime,
	extensionPath: string,
	cleanup: () => T,
): T | Promise<Awaited<T>> {
	const scope: ShutdownScope = { runtime, extensionPath, active: true };
	try {
		const result = shutdownScope.run(scope, cleanup);
		if (
			result !== null &&
			(typeof result === "object" || typeof result === "function") &&
			"then" in result &&
			typeof result.then === "function"
		) {
			return Promise.resolve(result).finally(() => {
				// Detached descendants inherit the scope object, but never its expired grant.
				scope.active = false;
			});
		}
		// Synchronous handlers must expire before their queued microtasks can run.
		scope.active = false;
		return result;
	} catch (error) {
		scope.active = false;
		throw error;
	}
}

/** Only stable cwd reads and the owning extension's exec helper use this exception. */
export function hasShutdownCleanupScope(runtime: ExtensionRuntime, extensionPath?: string): boolean {
	const scope = shutdownScope.getStore();
	return (
		scope?.active === true &&
		scope.runtime === runtime &&
		(extensionPath === undefined || scope.extensionPath === extensionPath)
	);
}
