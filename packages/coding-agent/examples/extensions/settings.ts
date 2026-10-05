/**
 * Settings Extension - Demonstrates typed extension settings
 *
 * The manifest declares the settings: a flat object of string, string enum,
 * boolean, and integer settings with titles, descriptions, defaults, and
 * bounds. Every client renders them as a form: in the TUI, open `/extensions`
 * (or `volt config`), pick the extension, and edit its settings. Values live
 * in settings.json under `extensions.settings-demo.settings`, globally or for
 * a trusted project.
 *
 * - `volt.settings` holds the effective values, typed from the manifest
 * - `settings_changed` fires when they change, from any client
 * - `volt.updateSettings()` stores new values
 *
 * Settings are plain JSON: keep credentials out of them (Volt refuses a string
 * setting named like one, such as `apiToken`).
 *
 * Usage:
 *   volt -e ./settings.ts
 *   /greet               - greets with the current settings
 *   /greet-style formal  - stores a new style in the global settings
 */

import { defineManifest, type ExtensionAPI, type ExtensionSettingsOf } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({
	id: "settings-demo",
	displayName: "Settings Demo",
	description: "Demonstrates typed extension settings.",
	settings: {
		type: "object",
		properties: {
			name: {
				type: "string",
				title: "Name",
				description: "Who /greet greets.",
				default: "world",
				minLength: 1,
				maxLength: 40,
			},
			style: {
				type: "string",
				title: "Style",
				enum: ["casual", "formal"],
				default: "casual",
			},
			excited: { type: "boolean", title: "Excited", description: "End greetings with an exclamation mark." },
			repeat: { type: "integer", title: "Repeat", minimum: 1, maximum: 5, default: 1 },
		},
	},
});

type Settings = ExtensionSettingsOf<typeof manifest>;

function greeting(settings: Settings): string {
	const words = settings.style === "formal" ? `Good day, ${settings.name}` : `Hi ${settings.name}`;
	const line = `${words}${settings.excited ? "!" : "."}`;
	return Array.from({ length: settings.repeat }, () => line).join(" ");
}

export default function (volt: ExtensionAPI<Settings>) {
	volt.registerCommand("greet", {
		description: "Greet with the current settings",
		handler: async (_args, ctx) => {
			// Typed: style is "casual" | "formal", repeat a number, excited boolean | undefined
			ctx.ui.notify(greeting(volt.settings), "info");
		},
	});

	volt.registerCommand("greet-style", {
		description: "Store the greeting style (casual or formal) in the global settings",
		getArgumentCompletions: (prefix) =>
			["casual", "formal"]
				.filter((style) => style.startsWith(prefix))
				.map((style) => ({ value: style, label: style })),
		handler: async (args, ctx) => {
			const style = args.trim();
			if (style !== "casual" && style !== "formal") {
				ctx.ui.notify("Usage: /greet-style casual|formal", "error");
				return;
			}
			// Validated against the manifest; a project scope needs a trusted project
			await volt.updateSettings({ style }, { scope: "global" });
		},
	});

	// Any client may change the settings: through the form, a protocol intent, or updateSettings
	volt.on("settings_changed", (event, ctx) => {
		ctx.ui.notify(`Settings changed (${event.scope}): ${greeting(event.settings)}`, "info");
	});
}
