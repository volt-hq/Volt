import { createHash } from "node:crypto";
import type { AgentMessage } from "@hansjm10/volt-agent-core";

export const MAX_SNAPSHOT_BYTES = 24_000;
export const MESSAGE_TYPE = "jev-guidance";

type SnapshotMessage = { index: number; role: string; text: string };
export type Snapshot = {
	latestUserRequest: SnapshotMessage | null;
	earlierUserMessages: SnapshotMessage[];
	recentMessages: SnapshotMessage[];
	historyIncomplete: boolean;
};

/** Best effort only: arbitrary secrets and personal information cannot be reliably detected. */
export function redact(text: string, credential?: string): string {
	let result = credential ? text.replaceAll(credential, "[redacted]") : text;
	result = result.replace(
		/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
		"[private key omitted]",
	);
	result = result.replace(/\bBearer\s+[^\s"'`,;]+/gi, "Bearer [redacted]");
	result = result.replace(/\b(?:sk-|vck_|ghp_|github_pat_)[A-Za-z0-9_-]{8,}/g, "[redacted]");
	return result.replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"'`,;}]+/gi, "$1[redacted]");
}

export function buildSnapshot(messages: AgentMessage[]): { state: Snapshot; userKey: string; fingerprint: string } {
	let incomplete = false;
	function project(message: AgentMessage, index: number): SnapshotMessage | undefined {
		let text = "";
		switch (message.role) {
			case "user":
			case "assistant":
				text =
					typeof message.content === "string"
						? message.content
						: message.content
								.map((part) => {
									if (part.type === "text") return part.text;
									if (part.type !== "toolCall") return "";
									const args = Object.fromEntries(
										Object.entries(part.arguments).filter(
											([key, value]) =>
												["path", "command", "action", "offset", "limit"].includes(key) &&
												["string", "number", "boolean"].includes(typeof value),
										),
									);
									return `Tool call: ${part.name} ${JSON.stringify(args)} (other arguments omitted)`;
								})
								.join("\n");
				break;
			case "toolResult":
				// Raw file bodies, web content, diffs, and tool details stay local.
				text = `Tool result: ${message.toolName}; isError=${message.isError}. `;
				text +=
					message.toolName === "bash"
						? message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n")
						: "Output omitted.";
				break;
			case "compactionSummary":
			case "branchSummary":
				text = message.summary;
				incomplete = true;
				break;
			default:
				incomplete = true;
				return undefined;
		}
		text = redact(text);
		const limit = message.role === "user" ? 3_000 : 1_200;
		if (text.length > limit) {
			text = `${text.slice(0, limit)}\n[truncated]`;
			incomplete = true;
		}
		return { index, role: message.role, text };
	}

	const latestUserIndex = messages.findLastIndex((message) => message.role === "user");
	const latestUserRequest = latestUserIndex < 0 ? null : (project(messages[latestUserIndex], latestUserIndex) ?? null);
	const recentStart = Math.max(0, messages.length - 12);
	const earlierUserMessages: SnapshotMessage[] = [];
	for (let index = recentStart - 1; index >= 0 && earlierUserMessages.length < 3; index--) {
		if (messages[index].role === "user" && index !== latestUserIndex) {
			const entry = project(messages[index], index);
			if (entry) earlierUserMessages.unshift(entry);
		}
	}
	const recentMessages = messages.slice(recentStart).flatMap((message, offset) => {
		const entry = project(message, recentStart + offset);
		return entry ? [entry] : [];
	});
	const state: Snapshot = {
		latestUserRequest,
		earlierUserMessages,
		recentMessages,
		historyIncomplete: incomplete || recentStart > 0,
	};
	while (Buffer.byteLength(JSON.stringify(state)) > MAX_SNAPSHOT_BYTES) {
		state.historyIncomplete = true;
		if (earlierUserMessages.length) earlierUserMessages.shift();
		else if (recentMessages.length) recentMessages.shift();
		else break;
	}
	const latestUser = messages[latestUserIndex];
	const userKey = createHash("sha256")
		.update(JSON.stringify([latestUserIndex, latestUser ?? null]))
		.digest("hex");
	const fingerprint = createHash("sha256").update(JSON.stringify(state)).digest("hex");
	return { state, userKey, fingerprint };
}
