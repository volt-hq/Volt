/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers bind tool execution to the runner context and to the session's lifetime.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 *
 * @param lostSignal Aborted, with the loss as its reason, when the owning session loses its
 *   log. An execution still running then is abandoned: nothing it produces can be saved, so a
 *   tool that ignores its own signal cannot keep the ending runtime alive. Ordinary
 *   cancellation still lets a cooperative tool return its own result.
 */
export function wrapRegisteredTool(
	registeredTool: RegisteredTool,
	runner: ExtensionRunner,
	lostSignal?: AbortSignal,
): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext(registeredTool.extensionPath));
	if (!lostSignal) return tool;
	return {
		...tool,
		execute: (toolCallId, params, signal, onUpdate) => {
			let acceptingUpdates = true;
			let abandon: (() => void) | undefined;
			return new Promise<AgentToolResult>((resolve, reject) => {
				abandon = () => {
					acceptingUpdates = false;
					reject(lostSignal.reason);
				};
				if (lostSignal.aborted) {
					abandon();
					return;
				}
				lostSignal.addEventListener("abort", abandon, { once: true });
				// Keep observing late rejection even if the loss wins the race.
				void tool
					.execute(
						toolCallId,
						params,
						signal,
						onUpdate
							? (result) => {
									if (acceptingUpdates) onUpdate(result);
								}
							: undefined,
					)
					.then(resolve, reject);
			}).finally(() => {
				acceptingUpdates = false;
				if (abandon) lostSignal.removeEventListener("abort", abandon);
			});
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(
	registeredTools: RegisteredTool[],
	runner: ExtensionRunner,
	lostSignal?: AbortSignal,
): AgentTool<any, any>[] {
	return registeredTools.map((registeredTool) => wrapRegisteredTool(registeredTool, runner, lostSignal));
}
