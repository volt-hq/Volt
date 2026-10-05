/**
 * Custom message presentation example.
 *
 * Shows how to use registerMessagePresenter to control how custom messages
 * look on every client: a styled title, a collapsed summary, and an expanded
 * body with details, as UI data with semantic tokens.
 *
 * Usage: /status [warn|error] [message] - sends a status message presented as UI data
 */

import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({
	id: "message-presenter",
	displayName: "Message Presenter",
	description: "Custom message presentation example.",
});

interface StatusDetails {
	level: string;
	timestamp: number;
}

export default function (volt: ExtensionAPI) {
	// How "status-update" messages look. Pure: the same message always presents the same way.
	volt.registerMessagePresenter<StatusDetails>("status-update", (message) => {
		const level = message.details?.level ?? "info";
		const token = level === "error" ? "error" : level === "warn" ? "warning" : "success";
		const text = typeof message.content === "string" ? message.content : "";
		const time = message.details?.timestamp ? new Date(message.details.timestamp).toISOString() : undefined;
		return {
			title: [{ text: `[${level.toUpperCase()}]`, token, bold: true }],
			summary: [{ type: "text", key: "text", text }],
			body: [
				{ type: "text", key: "text", text },
				...(time ? [{ type: "text" as const, key: "time", text: `at ${time}`, token: "muted" as const }] : []),
			],
		};
	});

	// Command to send status messages
	volt.registerCommand("status", {
		description: "Send a status message (usage: /status [warn|error] message)",
		handler: async (args, _ctx) => {
			const parts = args.trim().split(/\s+/);
			let level = "info";
			let content = args.trim();

			// Check for level prefix
			if (parts[0] === "warn" || parts[0] === "error") {
				level = parts[0];
				content = parts.slice(1).join(" ") || "Status update";
			}

			volt.sendMessage({
				customType: "status-update",
				content,
				display: true,
				details: { level, timestamp: Date.now() },
			});
		},
	});
}
