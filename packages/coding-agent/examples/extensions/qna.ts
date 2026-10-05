/**
 * Q&A extraction extension - extracts questions from assistant responses
 *
 * Demonstrates the "prompt generator" pattern:
 * 1. /qna command gets the last assistant message
 * 2. Shows a dialog while extracting (Cancel stops it)
 * 3. Loads the result into the editor for user to fill in answers
 */

import type { UserMessage } from "@hansjm10/volt-ai";
import { defineManifest, type ExtensionAPI, type ExtensionCommandContext } from "@hansjm10/volt-coding-agent";

const SYSTEM_PROMPT = `You are a question extractor. Given text from a conversation, extract any questions that need answering and format them for the user to fill in.

Output format:
- List each question on its own line, prefixed with "Q: "
- After each question, add a blank line for the answer prefixed with "A: "
- If no questions are found, output "No questions found in the last message."

Example output:
Q: What is your preferred database?
A: 

Q: Should we use TypeScript or JavaScript?
A: 

Keep questions in the order they appeared. Be concise.`;

/**
 * Run `work` while a dialog says what is happening: choosing Cancel or
 * dismissing the dialog aborts it, and the dialog closes once it settles.
 */
async function withProgressDialog<T>(
	ctx: ExtensionCommandContext,
	title: string,
	text: string,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const cancel = new AbortController();
	const close = new AbortController();
	void ctx.ui
		.dialog(
			{ title, body: [{ type: "text", text, token: "muted" }], actions: [{ id: "cancel", label: "Cancel" }] },
			{ signal: close.signal },
		)
		.then(() => {
			if (!close.signal.aborted) cancel.abort();
		});
	try {
		return await work(AbortSignal.any([cancel.signal, ctx.signal]));
	} finally {
		close.abort();
	}
}

export const manifest = defineManifest({
	id: "qna",
	displayName: "Q&A",
	description: "Extracts questions from assistant responses.",
});

export default function (volt: ExtensionAPI) {
	volt.registerCommand("qna", {
		description: "Extract questions from last assistant message into editor",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("qna requires a client that shows dialogs", "error");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// Find the last assistant message on the current branch
			const branch = ctx.sessionManager.getBranch();
			let lastAssistantText: string | undefined;

			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (entry.type === "message") {
					const msg = entry.message;
					if ("role" in msg && msg.role === "assistant") {
						if (msg.stopReason !== "stop") {
							ctx.ui.notify(`Last assistant message incomplete (${msg.stopReason})`, "error");
							return;
						}
						const textParts = msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text);
						if (textParts.length > 0) {
							lastAssistantText = textParts.join("\n");
							break;
						}
					}
				}
			}

			if (!lastAssistantText) {
				ctx.ui.notify("No assistant messages found", "error");
				return;
			}

			// Run the extraction while a dialog shows progress
			const text = lastAssistantText;
			const result = await withProgressDialog(
				ctx,
				"Q&A",
				`Extracting questions using ${ctx.model.id}...`,
				async (signal) => {
					const userMessage: UserMessage = {
						role: "user",
						content: [{ type: "text", text }],
						timestamp: Date.now(),
					};

					// The registry's client resolves the model's credentials.
					const response = await ctx.modelRegistry.client.complete(
						ctx.model!,
						{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
						{ signal },
					);

					if (response.stopReason === "aborted" || response.stopReason === "error") {
						return null;
					}

					return response.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n");
				},
			);

			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			ctx.ui.setEditorText(result);
			ctx.ui.notify("Questions loaded. Edit and submit when ready.", "info");
		},
	});
}
