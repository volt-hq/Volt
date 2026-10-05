/**
 * Summarize Extension
 *
 * /summarize asks GPT-5.2 for a summary of the conversation and shows it in a
 * dialog: Markdown as UI data that every client renders, closed with a button.
 */

import { getModel } from "@hansjm10/volt-ai";
import { defineManifest, type ExtensionAPI, type ExtensionCommandContext } from "@hansjm10/volt-coding-agent";

type ContentBlock = {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
};

type SessionEntry = {
	type: string;
	message?: {
		role?: string;
		content?: unknown;
	};
};

const extractTextParts = (content: unknown): string[] => {
	if (typeof content === "string") {
		return [content];
	}

	if (!Array.isArray(content)) {
		return [];
	}

	const textParts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") {
			textParts.push(block.text);
		}
	}

	return textParts;
};

const extractToolCallLines = (content: unknown): string[] => {
	if (!Array.isArray(content)) {
		return [];
	}

	const toolCalls: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") {
			continue;
		}

		const block = part as ContentBlock;
		if (block.type !== "toolCall" || typeof block.name !== "string") {
			continue;
		}

		const args = block.arguments ?? {};
		toolCalls.push(`Tool ${block.name} was called with args ${JSON.stringify(args)}`);
	}

	return toolCalls;
};

const buildConversationText = (entries: SessionEntry[]): string => {
	const sections: string[] = [];

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message?.role) {
			continue;
		}

		const role = entry.message.role;
		const isUser = role === "user";
		const isAssistant = role === "assistant";

		if (!isUser && !isAssistant) {
			continue;
		}

		const entryLines: string[] = [];
		const textParts = extractTextParts(entry.message.content);
		if (textParts.length > 0) {
			const roleLabel = isUser ? "User" : "Assistant";
			const messageText = textParts.join("\n").trim();
			if (messageText.length > 0) {
				entryLines.push(`${roleLabel}: ${messageText}`);
			}
		}

		if (isAssistant) {
			entryLines.push(...extractToolCallLines(entry.message.content));
		}

		if (entryLines.length > 0) {
			sections.push(entryLines.join("\n"));
		}
	}

	return sections.join("\n\n");
};

const buildSummaryPrompt = (conversationText: string): string =>
	[
		"Summarize this conversation so I can resume it later.",
		"Include goals, key decisions, progress, open questions, and next steps.",
		"Keep it concise and structured with headings.",
		"",
		"<conversation>",
		conversationText,
		"</conversation>",
	].join("\n");

const showSummaryUi = async (summary: string, ctx: ExtensionCommandContext) => {
	if (!ctx.hasUI) {
		return;
	}

	await ctx.ui.dialog({
		title: "Conversation Summary",
		body: [{ type: "markdown", markdown: summary }],
		actions: [{ id: "close", label: "Close" }],
	});
};

export const manifest = defineManifest({ id: "summarize", displayName: "Summarize" });

export default function (volt: ExtensionAPI) {
	volt.registerCommand("summarize", {
		description: "Summarize the current conversation in a dialog",
		handler: async (_args, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			const conversationText = buildConversationText(branch);

			if (!conversationText.trim()) {
				if (ctx.hasUI) {
					ctx.ui.notify("No conversation text found", "warning");
				}
				return;
			}

			if (ctx.hasUI) {
				ctx.ui.notify("Preparing summary...", "info");
			}

			const model = getModel("openai", "gpt-5.2");
			if (!model && ctx.hasUI) {
				ctx.ui.notify("Model openai/gpt-5.2 not found", "warning");
			}

			const hasAuth = model ? ctx.modelRegistry.hasConfiguredAuth(model) : false;
			if (model && !hasAuth && ctx.hasUI) {
				ctx.ui.notify("No API key for openai/gpt-5.2", "warning");
			}

			if (!model || !hasAuth) {
				return;
			}

			const summaryMessages = [
				{
					role: "user" as const,
					content: [{ type: "text" as const, text: buildSummaryPrompt(conversationText) }],
					timestamp: Date.now(),
				},
			];

			// The registry's client resolves the model's credentials.
			const response = await ctx.modelRegistry.client.complete(
				model,
				{ messages: summaryMessages },
				{ reasoningEffort: "high" },
			);
			if (response.stopReason === "error") {
				if (ctx.hasUI) ctx.ui.notify(response.error?.message ?? "Summary request failed", "warning");
				return;
			}

			const summary = response.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");

			await showSummaryUi(summary, ctx);
		},
	});
}
