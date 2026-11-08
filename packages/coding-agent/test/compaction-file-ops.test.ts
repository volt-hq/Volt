import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { describe, expect, it } from "vitest";
import { collectFileOps, computeFileLists } from "../src/core/compaction/utils.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

let nextId = 0;

function entry(message: AgentMessage): SessionEntry {
	nextId++;
	return { type: "message", id: `e${nextId}`, parentId: null, timestamp: new Date(0).toISOString(), message };
}

function toolResult(toolName: string, details: unknown): SessionEntry {
	return entry({
		role: "toolResult",
		toolCallId: `call-${nextId}`,
		toolName,
		content: [{ type: "text", text: "result" }],
		details,
		isError: false,
		timestamp: 0,
	});
}

function lists(entries: SessionEntry[]) {
	const fileOps = collectFileOps(entries);
	return {
		read: [...fileOps.read].sort(),
		written: [...fileOps.written].sort(),
		edited: [...fileOps.edited].sort(),
		...computeFileLists(fileOps),
	};
}

describe("collectFileOps", () => {
	it("counts the files a run_code script's nested read, write, and edit calls touched, whatever their status", () => {
		const result = lists([
			toolResult("run_code", {
				status: "failed",
				calls: [
					{ seq: 1, tool: "read", path: "src/a.ts", status: "completed", readOnly: true },
					{ seq: 2, tool: "edit", path: "src/b.ts", status: "failed", readOnly: false },
					{ seq: 3, tool: "write", path: "out.txt", status: "unsettled", readOnly: false },
					{ seq: 4, tool: "edit", path: "src/c.ts", status: "cancelled", readOnly: false },
					{ seq: 5, tool: "bash", status: "completed", readOnly: false },
				],
			}),
		]);

		expect(result).toMatchObject({
			read: ["src/a.ts"],
			edited: ["src/b.ts", "src/c.ts"],
			written: ["out.txt"],
			readFiles: ["src/a.ts"],
			modifiedFiles: ["out.txt", "src/b.ts", "src/c.ts"],
		});
	});

	it("merges nested paths with the paths of direct calls", () => {
		const result = lists([
			entry({
				role: "assistant",
				content: [{ type: "toolCall", id: "direct", name: "read", arguments: { path: "src/a.ts" } }],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			}),
			toolResult("run_code", { calls: [{ tool: "edit", path: "src/a.ts" }] }),
		]);

		expect(result).toMatchObject({ readFiles: [], modifiedFiles: ["src/a.ts"] });
	});

	it("ignores other tools' results and records that are not well-formed", () => {
		const result = lists([
			toolResult("bash", { calls: [{ tool: "edit", path: "from-bash.ts" }] }),
			toolResult("read", { calls: [{ tool: "read", path: "from-read.ts" }] }),
			toolResult("run_code", undefined),
			toolResult("run_code", "not details"),
			toolResult("run_code", { calls: "not calls" }),
			toolResult("run_code", { calls: { 0: { tool: "edit", path: "object.ts" } } }),
			toolResult("run_code", {
				calls: [
					null,
					"edit",
					["edit", "array.ts"],
					{ tool: "edit" },
					{ tool: "edit", path: "" },
					{ tool: "edit", path: 42 },
					{ tool: 7, path: "number-tool.ts" },
					{ tool: "mcp.github.edit", path: "mcp.ts" },
					{ tool: "grep", path: "grep.ts" },
					{ tool: "write", path: "kept.ts" },
				],
			}),
		]);

		expect(result).toMatchObject({ read: [], edited: [], written: ["kept.ts"] });
	});
});
