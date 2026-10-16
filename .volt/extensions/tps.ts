import type { AssistantMessage } from "@hansjm10/volt-ai";
import { defineManifest, type ExtensionAPI } from "@hansjm10/volt-coding-agent";

function isAssistantMessage(message: unknown): message is AssistantMessage {
	if (!message || typeof message !== "object") return false;
	const role = (message as { role?: unknown }).role;
	return role === "assistant";
}

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export const manifest = defineManifest({
	id: "tps",
	displayName: "TPS",
	description: "Reports output tokens per second after each turn.",
});

export default function (volt: ExtensionAPI) {
	let agentStartMs: number | null = null;

	volt.on("agent_start", () => {
		agentStartMs = Date.now();
	});

	volt.on("agent_end", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (agentStartMs === null) return;

		const elapsedMs = Date.now() - agentStartMs;
		agentStartMs = null;
		if (elapsedMs <= 0) return;

		let input = 0;
		let output = 0;
		let cacheRead = 0;
		let cacheWrite = 0;

		for (const message of event.messages) {
			if (!isAssistantMessage(message)) continue;
			input += message.usage.input || 0;
			output += message.usage.output || 0;
			cacheRead += message.usage.cacheRead || 0;
			cacheWrite += message.usage.cacheWrite || 0;
		}

		if (output <= 0) return;

		const elapsedSeconds = elapsedMs / 1000;
		const tokensPerSecond = output / elapsedSeconds;
		// Usage is summed over every model call in the run, so `promptTokens` is
		// the input billed for the run, not the size of the context window.
		const promptTokens = input + cacheRead + cacheWrite;
		const parts = [
			`${compactNumber.format(output)} tokens`,
			`${Math.round(tokensPerSecond)} tok/s`,
			`${elapsedSeconds.toFixed(1)}s`,
		];
		if (promptTokens > 0) {
			const cached = cacheRead + cacheWrite > 0 ? `, ${Math.round((cacheRead / promptTokens) * 100)}% cached` : "";
			parts.push(`${compactNumber.format(promptTokens)} input${cached}`);
		}
		const message = parts.join(" · ");
		ctx.ui.notify(message, "info");
	});
}
