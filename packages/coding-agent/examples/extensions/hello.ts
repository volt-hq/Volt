/**
 * Hello Tool - Minimal custom tool example
 */

import { Type } from "@hansjm10/volt-ai";
import { defineManifest, defineTool, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

const helloTool = defineTool({
	name: "hello",
	label: "Hello",
	description: "A simple greeting tool",
	parameters: Type.Object({
		name: Type.String({ description: "Name to greet" }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		return {
			content: [{ type: "text", text: `Hello, ${params.name}!` }],
			details: { greeted: params.name },
		};
	},
});

export const manifest = defineManifest({
	id: "hello",
	displayName: "Hello",
	description: "Minimal custom tool example.",
});

export default function (volt: ExtensionAPI) {
	volt.registerTool(helloTool);
}
