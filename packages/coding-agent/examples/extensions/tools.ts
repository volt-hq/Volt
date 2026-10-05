/**
 * Tools Extension
 *
 * Provides a /tools command to enable/disable tools with a form: one switch
 * per tool, which every client renders.
 * Tool selection persists across session reloads and respects branch navigation.
 *
 * Usage:
 * 1. Copy this file to ~/.volt/agent/extensions/ or your project's .volt/extensions/
 * 2. Use /tools to open the tool selector
 */

import { defineManifest, type ExtensionAPI, type ExtensionContext, type ToolInfo } from "@hansjm10/volt-coding-agent";

// State persisted to session
interface ToolsState {
	enabledTools: string[];
}

export const manifest = defineManifest({ id: "tools", displayName: "Tools" });

export default function toolsExtension(volt: ExtensionAPI) {
	// Track enabled tools
	let enabledTools: Set<string> = new Set();
	let allTools: ToolInfo[] = [];

	// Persist current state; the selection already applies, so a failed write is only reported.
	function persistState(ctx: ExtensionContext) {
		volt
			.appendEntry<ToolsState>("tools-config", {
				enabledTools: Array.from(enabledTools),
			})
			.catch((error: unknown) => ctx.ui.notify(`Could not save tool selection: ${String(error)}`, "error"));
	}

	// Apply current tool selection
	function applyTools() {
		volt.setActiveTools(Array.from(enabledTools));
	}

	// Find the last tools-config entry in the current branch
	function restoreFromBranch(ctx: ExtensionContext) {
		allTools = volt.getAllTools();

		// Get entries in current branch only
		const branchEntries = ctx.sessionManager.getBranch();
		let savedTools: string[] | undefined;

		for (const entry of branchEntries) {
			if (entry.type === "custom" && entry.customType === "tools-config") {
				const data = entry.data as ToolsState | undefined;
				if (data?.enabledTools) {
					savedTools = data.enabledTools;
				}
			}
		}

		if (savedTools) {
			// Restore saved tool selection (filter to only tools that still exist)
			const allToolNames = allTools.map((t) => t.name);
			enabledTools = new Set(savedTools.filter((t: string) => allToolNames.includes(t)));
			applyTools();
		} else {
			// No saved state - sync with currently active tools
			enabledTools = new Set(volt.getActiveTools());
		}
	}

	// Register /tools command
	volt.registerCommand("tools", {
		description: "Enable/disable tools",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/tools needs a client that shows forms", "error");
				return;
			}

			// Refresh tool list
			allTools = volt.getAllTools();

			// One switch per tool; field ids are positions, so any tool name works
			const values = await ctx.ui.form({
				title: "Tool Configuration",
				fields: allTools.map((tool, index) => ({
					kind: "boolean" as const,
					id: `tool-${index}`,
					label: tool.name,
					value: enabledTools.has(tool.name),
				})),
			});
			if (values === undefined) return;

			// Apply the selection and persist it; a switch the client left out keeps its state
			enabledTools = new Set(
				allTools
					.filter((tool, index) => (values[`tool-${index}`] ?? enabledTools.has(tool.name)) === true)
					.map((tool) => tool.name),
			);
			applyTools();
			persistState(ctx);
			ctx.ui.notify(`${enabledTools.size} of ${allTools.length} tools enabled`, "info");
		},
	});

	// Restore state on session start
	volt.on("session_start", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});

	// Restore state when navigating the session tree
	volt.on("session_tree", async (_event, ctx) => {
		restoreFromBranch(ctx);
	});
}
