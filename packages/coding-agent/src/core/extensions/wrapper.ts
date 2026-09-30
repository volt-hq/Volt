/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers bind tool execution to the runner context and conversation authority.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import type { ExtensionRunner } from "./runner.ts";
import type { RegisteredTool } from "./types.ts";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const tool = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	return {
		...tool,
		execute: async (toolCallId, params, signal, onUpdate) => {
			let acceptingUpdates = true;
			let unsubscribe: (() => void) | undefined;
			try {
				return await new Promise<AgentToolResult>((resolve, reject) => {
					unsubscribe = runner.subscribeConversationAuthorityLoss((error) => {
						// Only authority loss abandons execution. Ordinary cancellation must
						// let cooperative tools flush output and return their own result.
						acceptingUpdates = false;
						reject(error);
					});
					// Subscriptions replay an already-retired conversation immediately.
					if (!acceptingUpdates) return;
					// Keep observing late rejection even if authority loss wins the race.
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
				});
			} finally {
				acceptingUpdates = false;
				unsubscribe?.();
			}
		},
	};
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool<any, any>[] {
	return registeredTools.map((registeredTool) => wrapRegisteredTool(registeredTool, runner));
}
