/**
 * RPC Extension UI Demo
 *
 * Purpose-built extension that exercises all RPC-supported extension UI methods.
 * Designed to be loaded alongside the rpc-extension-ui-example.ts script to
 * demonstrate the full extension UI protocol.
 *
 * UI methods exercised:
 * - select() - on tool_call for dangerous bash commands
 * - confirm() - on session_before_switch
 * - input() - via /rpc-input command
 * - editor() - via /rpc-editor command
 * - dialog() - via /rpc-dialog command
 * - form() - via /rpc-form command
 * - notify() - after each dialog completes
 * - setStatus() - on turn_start/turn_end
 * - setPanel() - on session_start
 * - setTitle() - on session_start
 * - setEditorText() - via /rpc-prefill command
 * - getEditorText() - via /rpc-editor-text command
 */

import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

export const manifest = defineManifest({ id: "rpc-demo", displayName: "RPC Extension UI Demo" });

export default function (volt: ExtensionAPI) {
	let turnCount = 0;

	// -- setTitle, setPanel, setStatus on session lifecycle --

	volt.on("session_start", async (event, ctx) => {
		ctx.ui.setTitle(event.reason === "new" ? "volt RPC Demo (new session)" : "volt RPC Demo");
		ctx.ui.setPanel("rpc-demo", {
			title: "RPC Extension UI Demo",
			node: { type: "text", text: "Loaded and ready." },
		});
		ctx.ui.setStatus("rpc-demo", `Turns: ${turnCount}`);
	});

	// -- setStatus on turn lifecycle --

	volt.on("turn_start", async (_event, ctx) => {
		turnCount++;
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} running...`);
	});

	volt.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("rpc-demo", `Turn ${turnCount} done`);
	});

	// -- select on dangerous tool calls --

	volt.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command as string;
		const isDangerous = /\brm\s+(-rf?|--recursive)/i.test(command) || /\bsudo\b/i.test(command);

		if (isDangerous) {
			if (!ctx.hasUI) {
				return { block: true, reason: "Dangerous command blocked (no UI)" };
			}

			const choice = await ctx.ui.select(`Dangerous command: ${command}`, ["Allow", "Block"]);
			if (choice !== "Allow") {
				ctx.ui.notify("Command blocked by user", "warning");
				return { block: true, reason: "Blocked by user" };
			}
			ctx.ui.notify("Command allowed", "info");
		}

		return undefined;
	});

	// -- confirm on session clear --

	volt.on("session_before_switch", async (event, ctx) => {
		if (event.reason !== "new") return;
		if (!ctx.hasUI) return;

		const confirmed = await ctx.ui.confirm("Clear session?", "All messages will be lost.");
		if (!confirmed) {
			ctx.ui.notify("Clear cancelled", "info");
			return { cancel: true };
		}
	});

	// -- input via command --

	volt.registerCommand("rpc-input", {
		description: "Prompt for text input (demonstrates ctx.ui.input in RPC)",
		handler: async (_args, ctx) => {
			const value = await ctx.ui.input("Enter a value", "type something...");
			if (value) {
				ctx.ui.notify(`You entered: ${value}`, "info");
			} else {
				ctx.ui.notify("Input cancelled", "info");
			}
		},
	});

	// -- editor via command --

	volt.registerCommand("rpc-editor", {
		description: "Open multi-line editor (demonstrates ctx.ui.editor in RPC)",
		handler: async (_args, ctx) => {
			const text = await ctx.ui.editor("Edit some text", "Line 1\nLine 2\nLine 3");
			if (text) {
				ctx.ui.notify(`Editor submitted (${text.split("\n").length} lines)`, "info");
			} else {
				ctx.ui.notify("Editor cancelled", "info");
			}
		},
	});

	// -- setEditorText via command --

	volt.registerCommand("rpc-prefill", {
		description: "Prefill the input editor (demonstrates ctx.ui.setEditorText in RPC)",
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("This text was set by the rpc-demo extension.");
			ctx.ui.notify("Editor prefilled", "info");
		},
	});

	// -- dialog via command --

	volt.registerCommand("rpc-dialog", {
		description: "Show a dialog of UI data (demonstrates ctx.ui.dialog in RPC)",
		handler: async (_args, ctx) => {
			const choice = await ctx.ui.dialog({
				title: "Deploy?",
				body: [{ type: "markdown", markdown: "This would deploy **main** to staging." }],
				actions: [
					{ id: "deploy", label: "Deploy", token: "accent" },
					{ id: "cancel", label: "Cancel" },
				],
			});
			ctx.ui.notify(choice ? `Dialog answered: ${choice}` : "Dialog dismissed", "info");
		},
	});

	// -- form via command --

	volt.registerCommand("rpc-form", {
		description: "Show a form (demonstrates ctx.ui.form in RPC)",
		handler: async (_args, ctx) => {
			const values = await ctx.ui.form({
				title: "Release",
				fields: [
					{ kind: "string", id: "tag", label: "Tag", required: true, pattern: "v[0-9]+" },
					{ kind: "enum", id: "channel", label: "Channel", options: [{ value: "beta" }, { value: "stable" }] },
					{ kind: "boolean", id: "notes", label: "Write notes" },
				],
			});
			ctx.ui.notify(values ? `Form submitted: ${JSON.stringify(values)}` : "Form dismissed", "info");
		},
	});

	// -- getEditorText via command --

	volt.registerCommand("rpc-editor-text", {
		description: "Read the client's editor text (demonstrates ctx.ui.getEditorText in RPC)",
		handler: async (_args, ctx) => {
			const text = await ctx.ui.getEditorText();
			ctx.ui.notify(
				text === undefined ? "The client did not answer" : `Editor text: ${JSON.stringify(text)}`,
				"info",
			);
		},
	});
}
