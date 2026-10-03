/**
 * What a session reports about itself: its display name (set, or generated
 * from the first prompt), lifetime statistics, context usage, the user
 * messages a fork can start from, the last assistant text, and HTML and JSONL
 * exports.
 */

import type { AgentMessage, AgentTool } from "@hansjm10/volt-agent-core";
import type { Api, AssistantMessage, Model, TextContent } from "@hansjm10/volt-ai";
import { writeDurableAtomicFileSync } from "../../utils/durable-atomic-write.ts";
import { resolvePath } from "../../utils/paths.ts";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "../../utils/private-files.ts";
import type { AgentSessionEvent, AgentSessionState, SessionStats } from "../agent-session.ts";
import { calculateContextTokens, estimateContextTokens } from "../compaction/index.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "../export-html/index.ts";
import { createToolHtmlRenderer } from "../export-html/tool-renderer.ts";
import type { ContextUsage, ToolDefinition } from "../extensions/index.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { getPromptCacheRefreshUsage } from "../prompt-cache-keepalive.ts";
import { getLatestCompactionEntry, type SessionManager, serializeSessionJsonlSnapshot } from "../session-manager.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { getThemeByName, theme } from "../theme/runtime.ts";

/** The text of a user message's content, without its images. */
export function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("");
	}
	return "";
}

function sanitizeGeneratedSessionName(raw: string): string | undefined {
	const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? "";
	const name = firstLine
		.trim()
		.replace(/^["'`#*\s]+|["'`*\s.]+$/g, "")
		.replace(/\s+/g, " ");
	if (!name) {
		return undefined;
	}
	return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/**
 * Export the session's current branch to a JSONL file: the session header
 * followed by every entry on the branch path.
 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
 * @returns The resolved output file path.
 */
export function exportSessionToJsonl(sessionManager: SessionManager, outputPath?: string): string {
	const filePath = resolvePath(
		outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
		process.cwd(),
	);
	const header = sessionManager.getHeader();
	if (!header) throw new Error("Cannot export a session without a header");
	let parentId: string | null = null;
	const branchEntries = sessionManager.getBranch().map((entry) => {
		const linear = { ...entry, parentId };
		parentId = entry.id;
		return linear;
	});
	const content = serializeSessionJsonlSnapshot(header, branchEntries, sessionManager.getLeafId());

	writeDurableAtomicFileSync(filePath, content, {
		directoryMode: PRIVATE_DIRECTORY_MODE,
		fileMode: PRIVATE_FILE_MODE,
	});
	return filePath;
}

export interface SessionInfoHost {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	sessionWriter(): SessionWriter;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	isDisposed(): boolean;
	/** The model the active branch names. */
	model(): Model<Api> | undefined;
	/** The active branch's messages, copied. */
	messages(): AgentMessage[];
	/** The tools the conversation's requests carry. */
	activeTools(): readonly AgentTool[];
	/** The runtime state an HTML export renders. */
	state(): AgentSessionState;
	getToolDefinition(name: string): ToolDefinition | undefined;
	emit(event: AgentSessionEvent): void;
}

export class SessionInfo {
	private readonly host: SessionInfoHost;
	private nameGenerationInFlight = false;

	constructor(host: SessionInfoHost) {
		this.host = host;
	}

	/** Set a display name for the session. Resolves after the name commits. */
	async setName(name: string): Promise<void> {
		this.host.assertActive();
		await this.host.sessionWriter().appendSessionInfo(name);
		const resolvedName = this.host.sessionManager.getSessionName();
		this.host.emit({
			type: "session_info_changed",
			...(resolvedName === undefined ? {} : { name: resolvedName }),
		});
	}

	/**
	 * Best-effort, fire-and-forget: name an unnamed session from the user's
	 * prompt with a single tiny completion, so session lists show "Fix login
	 * crash" instead of a session-id prefix. Runs concurrently with the turn;
	 * an explicit name set in the meantime wins (checked again before commit).
	 * Never throws and never blocks or fails the prompt itself.
	 */
	maybeGenerateName(userText: string, assertConversationGenerationCurrent?: () => void): void {
		if (this.nameGenerationInFlight || this.host.sessionManager.getSessionName()) {
			return;
		}
		const model = this.host.model();
		const request = userText.trim();
		if (!model || !request) {
			return;
		}

		this.nameGenerationInFlight = true;
		void (async () => {
			try {
				const promptText =
					`Write a short title (3-6 words, plain text, no quotes, no trailing punctuation) ` +
					`for a coding session that starts with this request:\n\n<request>\n${request.slice(0, 2000)}\n</request>\n\n` +
					`Reply with only the title.`;
				const response = await this.host.modelRegistry.client.completeSimple(
					model,
					{
						systemPrompt: "You title coding assistant sessions.",
						messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
					},
					{ maxTokens: 64 },
				);
				if (response.stopReason === "error") {
					return;
				}
				const name = sanitizeGeneratedSessionName(
					response.content
						.filter((c): c is TextContent => c.type === "text")
						.map((c) => c.text)
						.join(" "),
				);
				assertConversationGenerationCurrent?.();
				if (name && !this.host.isDisposed() && !this.host.sessionManager.getSessionName()) {
					await this.setName(name);
				}
			} catch {
				// Naming is cosmetic; the session keeps its id-derived fallback.
			} finally {
				this.nameGenerationInFlight = false;
			}
		})();
	}

	/** Every user message in the session, for the fork selector. */
	userMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.host.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/** Lifetime session statistics. */
	stats(): SessionStats {
		// Agent state is the retained model context after compaction. The append-only
		// session entries preserve every message and therefore the lifetime totals.
		const entries = this.host.sessionManager.getEntries();
		const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const userMessages = messages.filter((message) => message.role === "user").length;
		const assistantMessages = messages.filter((message) => message.role === "assistant").length;
		const toolResults = messages.filter((message) => message.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((content) => content.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}
		// Prompt-cache refreshes are billed requests without messages.
		for (const entry of entries) {
			const usage = getPromptCacheRefreshUsage(entry);
			if (!usage) continue;
			totalInput += usage.input;
			totalOutput += usage.output;
			totalCacheRead += usage.cacheRead;
			totalCacheWrite += usage.cacheWrite;
			totalCost += usage.cost.total;
		}

		return {
			sessionRef: this.host.sessionManager.getSessionRef(),
			sessionId: this.host.sessionManager.getSessionId(),
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: messages.length + entries.filter((entry) => entry.type === "custom_message").length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.contextUsage(),
		};
	}

	/** The retained model context's estimated size, against the model's context window. */
	contextUsage(): ContextUsage | undefined {
		const model = this.host.model();
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.host.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.host.messages(), [...this.host.activeTools()]);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export the session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		this.host.assertActive();
		const configuredThemeName = this.host.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.host.getToolDefinition(name),
			theme,
			cwd: this.host.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.host.sessionManager, this.host.state(), {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Text content of the last assistant message, skipping aborted empty ones.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	lastAssistantText(): string | undefined {
		const lastAssistant = this.host
			.messages()
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}
}
