import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import {
	PRESENTATION_MAX_SERIALIZED_BYTES,
	PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
	type ToolPresentation,
	type UiNode,
} from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { lspOperationMetadata, lspResult } from "../src/core/lsp/outcome.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createInspectionToolDefinition } from "../src/core/tools/inspect.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createLspToolDefinition } from "../src/core/tools/lsp.ts";
import { BUILTIN_TOOL_PRESENTERS } from "../src/core/tools/presenters.ts";
import {
	presentFind,
	presentGrep,
	presentInspect,
	presentLs,
	presentLsp,
	presentMcp,
	presentRequestUserInput,
	presentWebFetch,
	presentWebSearch,
} from "../src/core/tools/query-presenters.ts";
import { createRequestUserInputToolDefinition } from "../src/core/tools/request-user-input.ts";
import { createWebFetchToolDefinition } from "../src/core/tools/web-fetch.ts";
import { createWebSearchToolDefinition } from "../src/core/tools/web-search.ts";
import {
	genericToolPresentation,
	HOST_UI_POLICY,
	presentToolCall,
	type ToolPresenter,
	type ToolPresentInput,
} from "../src/core/ui/presentation.ts";

const CWD = "/workspace";

function done(
	args: Record<string, unknown>,
	text: string,
	details?: unknown,
	isError = false,
	extra: (TextContent | ImageContent)[] = [],
): ToolPresentInput {
	return {
		args,
		argsComplete: true,
		state: "done",
		result: {
			content: [{ type: "text", text }, ...extra],
			...(details === undefined ? {} : { details }),
			isError,
			partial: false,
		},
		cwd: CWD,
	};
}

function pending(args: Record<string, unknown> = {}, argsComplete = false): ToolPresentInput {
	return { args, argsComplete, state: "pending", cwd: CWD };
}

function running(args: Record<string, unknown>, text = "", details?: unknown): ToolPresentInput {
	return {
		args,
		argsComplete: true,
		state: "running",
		result: {
			content: text ? [{ type: "text", text }] : [],
			...(details === undefined ? {} : { details }),
			isError: false,
			partial: true,
		},
		cwd: CWD,
	};
}

/** The presentation clients receive: the presenter's, normalized and fitted. */
function presented(
	name: string,
	present: ToolPresenter,
	input: ToolPresentInput,
	maxBytes = PRESENTATION_MAX_SERIALIZED_BYTES,
): ToolPresentation {
	const presentation = presentToolCall({ present, policy: HOST_UI_POLICY }, name, input, maxBytes);
	// The presenter's own output, never the generic fallback.
	expect(presentation).not.toEqual(genericToolPresentation(name, input, maxBytes));
	return presentation;
}

function plain(text: ToolPresentation["title"] | undefined): string {
	if (text === undefined) return "";
	return typeof text === "string" ? text : text.map((span) => span.text).join("");
}

/** Every text a tree shows, flattened. */
function texts(nodes: readonly UiNode[] | undefined): string {
	const out: string[] = [];
	const visit = (node: UiNode): void => {
		switch (node.type) {
			case "text":
				out.push(plain(node.text));
				break;
			case "markdown":
				out.push(node.markdown);
				break;
			case "terminal":
				out.push(...node.lines.map((line) => plain(line)));
				if (node.omittedLines) out.push(`[${node.omittedLines} omitted]`);
				break;
			case "code":
				out.push(node.code);
				break;
			case "list":
				node.items.forEach(visit);
				break;
			case "keyValue":
				for (const item of node.items) out.push(`${plain(item.label)}: ${plain(item.value)}`);
				break;
			case "table":
				for (const row of node.rows) out.push(row.cells.map((cell) => plain(cell)).join(" | "));
				break;
			case "card":
				out.push(plain(node.title));
				for (const section of node.sections ?? []) section.children.forEach(visit);
				break;
			case "progress":
				if (node.kind === "determinate") out.push(`${plain(node.label)} ${node.value}/${node.max ?? 1}`);
				break;
			default:
				break;
		}
	};
	nodes?.forEach(visit);
	return out.join("\n");
}

function find<T extends UiNode["type"]>(
	nodes: readonly UiNode[] | undefined,
	type: T,
): Extract<UiNode, { type: T }> | undefined {
	return nodes?.find((node): node is Extract<UiNode, { type: T }> => node.type === type);
}

describe("built-in query tool presenters", () => {
	it("register on their tool definitions and in the built-in set", () => {
		expect(createGrepToolDefinition(CWD).present).toBe(presentGrep);
		expect(createFindToolDefinition(CWD).present).toBe(presentFind);
		expect(createLsToolDefinition(CWD).present).toBe(presentLs);
		expect(createLspToolDefinition(CWD).present).toBe(presentLsp);
		expect(createInspectionToolDefinition(CWD).present).toBe(presentInspect);
		expect(createWebSearchToolDefinition(CWD).present).toBe(presentWebSearch);
		expect(createWebFetchToolDefinition(CWD).present).toBe(presentWebFetch);
		expect(createRequestUserInputToolDefinition().present).toBe(presentRequestUserInput);
		for (const [name, present] of [
			["grep", presentGrep],
			["find", presentFind],
			["ls", presentLs],
			["lsp", presentLsp],
			["inspect", presentInspect],
			["web_search", presentWebSearch],
			["web_fetch", presentWebFetch],
			["mcp", presentMcp],
			["request_user_input", presentRequestUserInput],
		] as const) {
			expect(BUILTIN_TOOL_PRESENTERS.get(name)).toBe(present);
		}
		for (const definition of [
			createGrepToolDefinition(CWD),
			createLsToolDefinition(CWD),
			createWebFetchToolDefinition(CWD),
			createRequestUserInputToolDefinition(),
		]) {
			expect(definition.renderCall).toBeUndefined();
			expect(definition.renderResult).toBeUndefined();
		}
	});

	it("title calls whose arguments are streaming, missing, or of the wrong type", () => {
		expect(plain(presented("grep", presentGrep, pending()).title)).toBe("grep … in .");
		expect(plain(presented("grep", presentGrep, pending({ pattern: 3, path: ["x"] })).title)).toBe(
			"grep [invalid arg] in [invalid arg]",
		);
		expect(plain(presented("find", presentFind, pending({ pattern: "*.ts" })).title)).toBe("find *.ts in .");
		expect(plain(presented("ls", presentLs, pending()).title)).toBe("ls .");
		expect(plain(presented("lsp", presentLsp, pending()).title)).toBe("lsp …");
		expect(plain(presented("inspect", presentInspect, pending()).title)).toBe("inspect …");
		expect(plain(presented("web_search", presentWebSearch, pending()).title)).toBe("web_search …");
		expect(plain(presented("web_fetch", presentWebFetch, pending({ url: 1 })).title)).toBe("web_fetch [invalid arg]");
		expect(plain(presented("mcp", presentMcp, pending()).title)).toBe("mcp …");
		expect(plain(presented("request_user_input", presentRequestUserInput, pending()).title)).toBe("ask user");
	});

	it("keep paths as the call spells them", () => {
		const home = "/home/someone/project/src";
		const grep = presented("grep", presentGrep, pending({ pattern: "x", path: home }));
		expect(plain(grep.title)).toContain(home);
		expect(plain(grep.title)).not.toContain("~");
		expect(plain(presented("ls", presentLs, pending({ path: home })).title)).toContain(home);
	});

	describe("grep", () => {
		const args = { pattern: "TODO", path: "src", glob: "*.ts", limit: 50 };

		it("shows the pattern, scope, the match count, and the first lines collapsed", () => {
			const lines = Array.from({ length: 20 }, (_, index) => `src/a.ts:${index + 1}: TODO ${index}`);
			const presentation = presented("grep", presentGrep, done(args, lines.join("\n")));
			expect(plain(presentation.title)).toBe("grep /TODO/ in src (*.ts) limit 50");
			expect(presentation.showsDuration).toBe(true);
			expect(texts(presentation.summary)).toContain("20 matches");
			expect(find(presentation.summary, "terminal")?.lines).toHaveLength(15);
			expect(texts(presentation.summary)).toContain("… 5 more lines");
			expect(find(presentation.body, "terminal")?.lines).toHaveLength(20);
		});

		it("counts only match lines, leaves no body for short output, and warns about limits", () => {
			const text = [
				"src/a.ts-1- before",
				"src/a.ts:2: TODO",
				"src/a.ts-3- after",
				"",
				"[50 matches limit reached. Use limit=100 for more, or refine pattern. 50.0KB limit reached]",
			].join("\n");
			const presentation = presented(
				"grep",
				presentGrep,
				done(args, text, { matchLimitReached: 50, truncation: { truncated: true, maxBytes: 51200 } }),
			);
			const summary = texts(presentation.summary);
			expect(summary).toContain("1 match (limit reached)");
			expect(summary).toContain("[Truncated: 50 matches limit, 50.0KB limit]");
			expect(summary).not.toContain("refine pattern");
			expect(presentation.body).toBeUndefined();
		});

		it("shows no matches, and failures in the error token", () => {
			expect(texts(presented("grep", presentGrep, done(args, "No matches found")).summary)).toBe("No matches found");
			const failed = presented("grep", presentGrep, done(args, "Path not found: src", undefined, true));
			const terminal = find(failed.summary, "terminal");
			expect(terminal?.lines).toEqual([[{ text: "Path not found: src", token: "error" }]]);
		});

		it("turns ANSI output into tokens", () => {
			const presentation = presented("grep", presentGrep, done(args, "src/a.ts:1: \u001b[31mred\u001b[0m"));
			expect(JSON.stringify(presentation)).not.toContain("\u001b");
			expect(JSON.stringify(find(presentation.summary, "terminal"))).toContain('"token":"error"');
		});

		it("fits oversized output by trimming its lines, not by falling back", () => {
			// grep bounds its own output to 50 KB; the remote bound is 16 KB.
			const lines = Array.from({ length: 600 }, (_, index) => `src/file.ts:${index}: ${"x".repeat(60)}`);
			const input = done(args, lines.join("\n"));
			const local = presented("grep", presentGrep, input);
			expect(find(local.body, "terminal")?.lines).toHaveLength(600);
			const remote = presented("grep", presentGrep, input, PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
			expect(JSON.stringify(remote).length).toBeLessThanOrEqual(PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES);
			expect(plain(remote.title)).toContain("/TODO/");
			expect(find(remote.body, "terminal")?.omittedLines).toBeGreaterThan(0);
			expect(texts(remote.summary)).toContain("600 matches");
		});
	});

	describe("find and ls", () => {
		it("lists found paths with their count, every path expanded", () => {
			const paths = Array.from({ length: 25 }, (_, index) => `src/file-${index}.ts`);
			const presentation = presented(
				"find",
				presentFind,
				done({ pattern: "*.ts", path: "src", limit: 25 }, `${paths.join("\n")}\n\n[25 results limit reached]`, {
					resultLimitReached: 25,
				}),
			);
			expect(plain(presentation.title)).toBe("find *.ts in src (limit 25)");
			expect(texts(presentation.summary)).toContain("25 files (limit reached)");
			const list = find(presentation.summary, "list");
			expect(list?.items).toHaveLength(20);
			expect(texts(presentation.summary)).toContain("… 5 more lines");
			expect(texts(presentation.summary)).toContain("[Truncated: 25 results limit]");
			expect(find(presentation.body, "terminal")?.lines).toEqual(paths);
		});

		it("shows when find found nothing", () => {
			const presentation = presented(
				"find",
				presentFind,
				done({ pattern: "*.zz" }, "No files found matching pattern"),
			);
			expect(texts(presentation.summary)).toBe("No files found matching pattern");
		});

		it("shows directory entries as terminal lines, the first twenty collapsed", () => {
			const entries = Array.from({ length: 30 }, (_, index) => `entry-${index}`);
			const presentation = presented(
				"ls",
				presentLs,
				done(
					{ path: "src", limit: 30 },
					`${entries.join("\n")}\n\n[30 entries limit reached. Use limit=60 for more]`,
					{
						entryLimitReached: 30,
					},
				),
			);
			expect(plain(presentation.title)).toBe("ls src (limit 30)");
			expect(find(presentation.summary, "terminal")?.lines).toHaveLength(20);
			expect(texts(presentation.summary)).toContain("[Truncated: 30 entries limit]");
			expect(find(presentation.body, "terminal")?.lines).toEqual(entries);
			expect(texts(presented("ls", presentLs, done({}, "(empty directory)")).summary)).toBe("(empty directory)");
		});
	});

	describe("lsp", () => {
		function lspDone(
			args: Record<string, unknown>,
			outcome: Parameters<typeof lspResult>[0],
			text: string,
			evidence: Parameters<typeof lspResult>[2] = {},
			isError = false,
		): ToolPresentInput {
			const result = lspResult(outcome, text, evidence);
			const action = typeof args.action === "string" ? args.action : "status";
			return done(
				args,
				result.text,
				{ action, lsp: lspOperationMetadata(result, "explicit", action, performance.now()) },
				isError,
			);
		}

		it("titles the action, path and line, symbol, rename, and fix title", () => {
			expect(
				plain(
					presented(
						"lsp",
						presentLsp,
						pending({ action: "rename", path: "src/a.ts", line: 4, symbol: "foo", newName: "bar" }),
					).title,
				),
			).toBe("lsp rename src/a.ts:4 foo -> bar");
			expect(
				plain(
					presented("lsp", presentLsp, pending({ action: "fix", path: "src/a.ts", title: "Add import" })).title,
				),
			).toBe('lsp fix src/a.ts "Add import"');
		});

		it("shows diagnostics as a table with severity tokens", () => {
			const text = [
				"src/a.ts(3,5): error: Cannot find name 'x'. [typescript 2304]",
				"src/a.ts(9,1): warning: Unused variable [eslint no-unused-vars]",
				"src/a.ts(10,2): hint: Prefer const",
				"... and 2 more",
			].join("\n");
			const presentation = presented(
				"lsp",
				presentLsp,
				lspDone({ action: "diagnostics", path: "src/a.ts" }, "success", text, {
					freshness: "fresh",
					source: "pull",
					diagnosticCount: 5,
				}),
			);
			const table = find(presentation.summary, "table");
			expect(table?.columns.map((column) => column.header)).toEqual(["Location", "Severity", "Message"]);
			expect(table?.rows.map((row) => row.cells)).toEqual([
				["src/a.ts:3:5", [{ text: "error", token: "error" }], "Cannot find name 'x'. [typescript 2304]"],
				["src/a.ts:9:1", [{ text: "warning", token: "warning" }], "Unused variable [eslint no-unused-vars]"],
				["src/a.ts:10:2", [{ text: "hint", token: "muted" }], "Prefer const"],
			]);
			expect(texts(presentation.summary)).toContain("... and 2 more");
			expect(texts(presentation.summary)).not.toContain("Diagnostics:");
		});

		it("collapses long diagnostics tables to ten rows", () => {
			const text = Array.from(
				{ length: 14 },
				(_, index) => `src/a.ts(${index + 1},1): error: problem ${index}`,
			).join("\n");
			const presentation = presented(
				"lsp",
				presentLsp,
				lspDone({ action: "diagnostics", path: "src/a.ts" }, "success", text),
			);
			expect(find(presentation.summary, "table")?.rows).toHaveLength(10);
			expect(texts(presentation.summary)).toContain("… 4 more diagnostics");
			expect(find(presentation.body, "table")?.rows).toHaveLength(14);
		});

		it("warns about diagnostics that are not fresh, shows status output, and failures", () => {
			// Ported from the LSP tool card checks: uncertainty, idle status, and failure.
			const degraded = presented(
				"lsp",
				presentLsp,
				lspDone({ action: "diagnostics", path: "src/main.ts" }, "empty", "No diagnostics reported.", {
					source: "push",
					freshness: "unverified",
				}),
			);
			expect(texts(degraded.summary)).toContain("Diagnostics: unverified (push)");
			expect(degraded.summary?.[0]).toMatchObject({ type: "text", token: "warning" });
			expect(texts(degraded.summary)).toContain("No diagnostics reported.");

			const idle = presented("lsp", presentLsp, lspDone({ action: "status" }, "empty", "typescript: idle"));
			expect(texts(idle.summary)).toBe("typescript: idle");

			const failed = presented(
				"lsp",
				presentLsp,
				lspDone(
					{ action: "diagnostics", path: "src/main.ts" },
					"unavailable",
					"TypeScript 6.0.2 is incompatible; native LSP requires >=7.",
					{},
					true,
				),
			);
			expect(find(failed.summary, "terminal")?.lines).toEqual([
				[{ text: "TypeScript 6.0.2 is incompatible; native LSP requires >=7.", token: "error" }],
			]);
		});
	});

	describe("inspect", () => {
		it("titles the resolved command, or the operation while it does not resolve", () => {
			expect(
				plain(
					presented("inspect", presentInspect, pending({ operation: "git.log", args: ["--oneline", "-5"] }, true))
						.title,
				),
			).toMatch(/^inspect git log .*--oneline -5$/);
			expect(plain(presented("inspect", presentInspect, pending({ operation: "git.log", args: [1] })).title)).toBe(
				"inspect git.log",
			);
		});

		it("shows output collapsed to ten lines, with the truncation and full output path", () => {
			const lines = Array.from({ length: 12 }, (_, index) => `commit ${index}`);
			const text = `${lines.join("\n")}\n\n[Showing 12 of 4000 lines (50.0KB limit). Full output: /tmp/volt-inspect.log]`;
			const presentation = presented(
				"inspect",
				presentInspect,
				done({ operation: "git.log" }, text, {
					command: "git log",
					truncation: { truncated: true, outputLines: 12, totalLines: 4000, maxBytes: 51200 },
					fullOutputPath: "/tmp/volt-inspect.log",
				}),
			);
			expect(presentation.showsDuration).toBe(true);
			expect(find(presentation.summary, "terminal")?.lines).toHaveLength(10);
			expect(find(presentation.body, "terminal")?.lines).toEqual(lines);
			expect(texts(presentation.summary)).toContain(
				"[Truncated: showing 12 of 4000 lines (50.0KB limit). Full output: /tmp/volt-inspect.log]",
			);
		});
	});

	describe("web_search", () => {
		const results = Array.from({ length: 7 }, (_, index) => ({
			title: `Result ${index}`,
			url: `https://example.com/${index}`,
			snippet: `Snippet ${index}`,
			...(index === 0 ? { publishedAt: "2026-01-01", source: "Example News" } : {}),
		}));

		it("shows the query and scope, a count and titles collapsed, and a card per result expanded", () => {
			const args = { query: "volt rewrite", domains: ["example.com"], recencyDays: 7, limit: 7 };
			const presentation = presented(
				"web_search",
				presentWebSearch,
				done(args, "Web search results (brave)\n...", {
					query: "volt rewrite",
					submittedQuery: "volt rewrite 2026",
					provider: "brave",
					results,
					resultLimitReached: 7,
				}),
			);
			expect(plain(presentation.title)).toBe("web_search volt rewrite (example.com) last 7 days limit 7");
			expect(texts(presentation.summary)).toContain("7 results (brave)");
			expect(find(presentation.summary, "list")?.items).toHaveLength(5);
			expect(texts(presentation.summary)).toContain("… 2 more results");
			expect(texts(presentation.summary)).toContain("[Truncated: 7 results limit]");
			const cards = presentation.body?.filter((node) => node.type === "card") ?? [];
			expect(cards).toHaveLength(7);
			expect(texts([cards[0] as UiNode])).toBe(
				["[1] Result 0", "https://example.com/0", "Snippet 0", "Published 2026-01-01 · Example News"].join("\n"),
			);
			expect(texts(presentation.body)).toContain("Submitted query: volt rewrite 2026");
		});

		it("falls back to the provider's text without structured results", () => {
			const presentation = presented(
				"web_search",
				presentWebSearch,
				done({ query: "x" }, "Web search results (openai)\nQuery: x\n\nSome prose answer", {
					query: "x",
					provider: "openai",
					results: [],
				}),
			);
			expect(texts(presentation.summary)).toContain("Some prose answer");
		});
	});

	describe("web_fetch", () => {
		it("shows the page's details, its first lines collapsed, and its text as literal lines expanded", () => {
			const content = Array.from({ length: 30 }, (_, index) => `Paragraph ${index}`).join("\n");
			const text = `Fetched: https://example.com/page\nTitle: Example\n\n${content}\n\n[20.0KB limit reached]\n\n[Download truncated at 1.0MB]`;
			const presentation = presented(
				"web_fetch",
				presentWebFetch,
				done({ url: "https://example.com/p" }, text, {
					url: "https://example.com/page",
					requestedUrl: "https://example.com/p",
					title: "Example",
					contentType: "text/html",
					truncation: { truncated: true, truncatedBy: "bytes", maxBytes: 20_480 },
					downloadTruncation: { maxBytes: 1_048_576 },
				}),
			);
			expect(plain(presentation.title)).toBe("web_fetch https://example.com/p");
			const page = find(presentation.summary, "keyValue");
			expect(page?.items.map((item) => item.label)).toEqual(["URL", "Requested", "Title", "Content type"]);
			const summary = find(presentation.summary, "terminal");
			expect(summary?.lines).toHaveLength(16);
			expect(summary?.lines[0]).toBe("Paragraph 0");
			expect(texts(presentation.summary)).toContain("[Truncated: 20.0KB limit]");
			expect(texts(presentation.summary)).toContain("[Download truncated: 1.0MB limit]");
			// Fetched text is untrusted: it shows as it is, never as Markdown.
			expect(find(presentation.body, "markdown")).toBeUndefined();
			expect(find(presentation.body, "terminal")?.lines).toEqual(content.split("\n"));
		});

		it("keeps a large page within the bound by trimming its oldest lines", () => {
			const content = Array.from(
				{ length: 2_000 },
				(_, index) => `Line ${index} [link](https://example.com) ${"y".repeat(20)}`,
			).join("\n");
			const presentation = presented(
				"web_fetch",
				presentWebFetch,
				done({ url: "https://example.com" }, `Fetched: https://example.com\n\n${content}`, {
					url: "https://example.com",
				}),
			);
			expect(find(presentation.body, "markdown")).toBeUndefined();
			expect(find(presentation.body, "terminal")?.omittedLines).toBeGreaterThan(0);
		});
	});

	describe("mcp", () => {
		it("titles gateway actions as the old call line did", () => {
			expect(
				plain(presented("mcp", presentMcp, pending({ action: "call", server: "gh", tool: "issues" })).title),
			).toBe("mcp gh.issues");
			expect(plain(presented("mcp", presentMcp, pending({ action: "search", query: "issues" })).title)).toBe(
				"mcp search issues",
			);
			expect(
				plain(presented("mcp", presentMcp, pending({ action: "describe", server: "gh", tool: "issues" })).title),
			).toBe("mcp describe gh.issues");
			expect(plain(presented("mcp", presentMcp, pending({ action: "status" })).title)).toBe("mcp status");
			expect(plain(presented("mcp", presentMcp, pending({ action: "call", server: 5 })).title)).toBe(
				"mcp [invalid arg]",
			);
		});

		it("shows the result as JSON, its first 18 lines collapsed", () => {
			const result = { action: "call", items: Array.from({ length: 20 }, (_, index) => index) };
			const presentation = presented(
				"mcp",
				presentMcp,
				done({ action: "call", server: "gh", tool: "issues" }, "formatted", { result }),
			);
			const summary = find(presentation.summary, "code");
			expect(summary?.language).toBe("json");
			expect(summary?.code.split("\n")).toHaveLength(18);
			expect(find(presentation.body, "code")?.code).toBe(JSON.stringify(result, null, 2));
		});

		it("shows a running MCP server call's progress, and its message without a total", () => {
			const args = { server: "gh", tool: "search" };
			const live = presented("mcp", presentMcp, running(args, "page 1", { progress: 1, total: 3 }));
			expect(plain(live.title)).toBe("mcp gh.search");
			expect(find(live.summary, "progress")).toMatchObject({
				kind: "determinate",
				value: 1,
				max: 3,
				label: "page 1",
			});
			const unknown = presented("mcp", presentMcp, running(args, "working", { progress: 4 }));
			expect(texts(unknown.summary)).toBe("working");
			const ended = presented("mcp", presentMcp, done(args, "page 3"));
			expect(texts(ended.summary)).toBe("page 3");
		});
	});

	describe("request_user_input", () => {
		const args = {
			questions: [
				{ id: "scope", header: "Scope", question: "Which clients should this cover?", options: [] },
				{ id: "store", header: "Storage\u001b[31m", question: "Where?", options: [] },
			],
		};

		it("titles the question headers as plain text", () => {
			const presentation = presented("request_user_input", presentRequestUserInput, pending(args, true));
			expect(plain(presentation.title)).toBe("ask user · Scope · Storage");
			expect(presentation.activity).toBe("Waiting to run");
			expect(presented("request_user_input", presentRequestUserInput, running(args)).activity).toBe(
				"Waiting for answers",
			);
		});

		it("shows answers as key-value pairs, each under its full question expanded", () => {
			const presentation = presented(
				"request_user_input",
				presentRequestUserInput,
				done(args, '{"status":"answered"}', {
					questions: args.questions,
					status: "answered",
					answers: { scope: { answers: ["CLI first (Recommended)", "note"] } },
				}),
			);
			expect(texts(presentation.summary)).toBe(
				"Scope: CLI first (Recommended) · note\nStorage: Skipped · no answer",
			);
			expect(texts(presentation.summary)).not.toContain('"answers"');
			expect(texts(presentation.body)).toContain("Which clients should this cover?");
			expect(presentation.showsDuration).toBeUndefined();
		});

		it("shows cancelled and unavailable requests and errors", () => {
			const cancelled = done(args, "{}", { questions: args.questions, status: "cancelled", answers: {} });
			expect(texts(presented("request_user_input", presentRequestUserInput, cancelled).summary)).toBe(
				"Cancelled · turn stopped",
			);
			const unavailable = done(args, "{}", { questions: args.questions, status: "unavailable", answers: {} });
			expect(texts(presented("request_user_input", presentRequestUserInput, unavailable).summary)).toBe(
				"Question UI unavailable · no answers",
			);
			const failed = presented(
				"request_user_input",
				presentRequestUserInput,
				done(args, "Question ids must be unique within a request.", undefined, true),
			);
			expect(failed.summary?.[0]).toMatchObject({
				token: "error",
				text: "Question ids must be unique within a request.",
			});
		});
	});
});
