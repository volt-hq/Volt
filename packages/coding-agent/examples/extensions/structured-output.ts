/**
 * Structured Output Tool
 *
 * Demonstrates `disposition: "stop"` so the agent can end on a tool call
 * without paying for an extra follow-up LLM turn.
 */

import { defineManifest, defineTool, type ExtensionAPI } from "@hansjm10/volt-coding-agent";
import { Type } from "typebox";

interface StructuredOutputDetails {
	headline: string;
	summary: string;
	actionItems: string[];
}

const structuredOutputTool = defineTool({
	name: "structured_output",
	label: "Structured Output",
	description:
		"Return a final structured answer. Use this as your last action when the user asks for structured output or a machine-readable summary.",
	promptSnippet: "Emit a final structured answer as a terminating tool result",
	promptGuidelines: [
		"Use structured_output as your final action when the user asks for structured output, JSON-like output, or a machine-readable summary.",
		"After calling structured_output, do not emit another assistant response in the same turn.",
	],
	parameters: Type.Object({
		headline: Type.String({ description: "Short title for the result" }),
		summary: Type.String({ description: "One-paragraph summary" }),
		actionItems: Type.Array(Type.String(), { description: "Concrete next steps or key bullets" }),
	}),

	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `Saved structured output: ${params.headline}` }],
			details: {
				headline: params.headline,
				summary: params.summary,
				actionItems: params.actionItems,
			} satisfies StructuredOutputDetails,
			disposition: "stop",
		};
	},

	present({ args, state, result }) {
		const title = [
			{ text: "structured_output ", bold: true },
			{ text: args.headline ?? "…", token: "accent" as const },
		];
		const details = result?.details;
		if (state !== "done" || !details) return { title };
		return {
			title,
			summary: [{ type: "text", key: "summary", text: details.summary }],
			body: [
				{ type: "text", key: "summary", text: details.summary },
				{
					type: "list",
					key: "actions",
					ordered: true,
					items: details.actionItems.map((item, index) => ({
						type: "text" as const,
						key: `item-${index}`,
						text: item,
						token: "muted" as const,
					})),
				},
			],
		};
	},
});

export const manifest = defineManifest({ id: "structured-output", displayName: "Structured Output" });

export default function (volt: ExtensionAPI) {
	volt.registerTool(structuredOutputTool);
}
