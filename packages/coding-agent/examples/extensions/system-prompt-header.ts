/**
 * Displays a status widget showing the system prompt length.
 *
 * Demonstrates ctx.getSystemPrompt() for accessing the effective system prompt.
 */
import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({
	id: "system-prompt-header",
	displayName: "System Prompt Header",
	description: "Displays a status widget showing the system prompt length.",
});

export default function (volt: ExtensionAPI) {
	volt.on("agent_start", (_event, ctx) => {
		const prompt = ctx.getSystemPrompt();
		ctx.ui.setStatus("system-prompt", `System: ${prompt.length} chars`);
	});

	volt.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setStatus("system-prompt", undefined);
	});
}
