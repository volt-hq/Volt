/**
 * The HTML export of presentations (export-html/ui-node-html.ts): tool calls
 * and custom messages export as the `UiNode` data every client renders, all
 * text escaped, styling a closed set of classes, and images only as base64
 * data of the four image types.
 */

import type { AssistantMessage } from "@hansjm10/volt-ai";
import type { UiNode } from "@hansjm10/volt-protocol";
import { describe, expect, it } from "vitest";
import { presentSessionEntries } from "../src/core/export-html/index.ts";
import { styledTextHtml, toolPresentationHtml, uiNodeHtml } from "../src/core/export-html/ui-node-html.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { BUILTIN_PRESENTERS } from "../src/core/tools/presenters.ts";
import { HOST_UI_POLICY } from "../src/core/ui/presentation.ts";

const XSS = `<script>alert("x")</script><img src=x onerror='y'>`;

describe("presentations in the HTML export", () => {
	it("escapes every text field and attribute", () => {
		const nodes: UiNode[] = [
			{ type: "text", text: [{ text: XSS, token: "error", bold: true }] },
			{ type: "markdown", markdown: XSS },
			{ type: "terminal", lines: [XSS, [{ text: XSS, token: "warning" }]], title: XSS },
			{ type: "code", code: XSS, language: "ts", title: XSS },
			{ type: "diff", path: XSS, lines: [{ kind: "add", text: XSS, newLine: 1 }], lineNumbers: true },
			{ type: "keyValue", items: [{ label: XSS, value: XSS }] },
			{ type: "table", columns: [{ header: XSS }], rows: [{ cells: [XSS] }] },
			{ type: "list", items: [{ type: "text", text: XSS }] },
			{ type: "tree", items: [{ id: "a", label: XSS, children: [{ id: "b", label: XSS }] }] },
			{
				type: "card",
				title: XSS,
				badges: [{ label: XSS }],
				sections: [{ title: XSS, children: [{ type: "text", text: XSS }] }],
				actions: [{ id: "a", label: XSS, intent: { type: "prompt" } }],
			},
			{ type: "actions", actions: [{ id: "a", label: XSS, intent: { type: "prompt" } }] },
			{ type: "progress", kind: "steps", steps: [{ label: XSS, status: "done", detail: XSS }] },
			{ type: "form", title: XSS, fields: [{ kind: "string", id: "f", label: XSS }], submit: { type: "prompt" } },
			{ type: "image", mimeType: "image/png", data: "AAAA", alt: XSS },
		];
		const html = nodes.map(uiNodeHtml).join("");
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img src=x");
		expect(html).not.toMatch(/onerror='/);
		expect(html).toContain("&lt;script&gt;");
		// Nothing exported runs or submits: actions and forms are text.
		expect(html).not.toMatch(/<(button|form|input|a)\b/);
	});

	it("styles only with the closed set of token classes, and embeds only image data", () => {
		const forged = { type: "text", text: [{ text: "x", token: 'error" onclick="x' }] } as unknown as UiNode;
		expect(uiNodeHtml(forged)).not.toContain("onclick");
		expect(styledTextHtml([{ text: "ok", token: "success" }])).toBe('<span class="ui-token-success">ok</span>');
		const badImage = { type: "image", mimeType: "text/html", data: "PHNjcmlwdD4=" } as unknown as UiNode;
		expect(uiNodeHtml(badImage)).toBe("");
		const badData = { type: "image", mimeType: "image/png", data: '" onload="x' } as unknown as UiNode;
		expect(uiNodeHtml(badData)).toBe("");
		expect(uiNodeHtml({ type: "image", mimeType: "image/png", data: "AAAA" })).toContain(
			'src="data:image/png;base64,AAAA"',
		);
	});

	it("exports a hidden presentation as nothing, and others collapsed and expanded", () => {
		expect(toolPresentationHtml({ title: "t", hidden: true })).toBeUndefined();
		expect(
			toolPresentationHtml({
				title: "t",
				summary: [{ type: "text", text: "short" }],
				body: [{ type: "text", text: "long" }],
			}),
		).toMatchObject({ collapsed: expect.stringContaining("short"), expanded: expect.stringContaining("long") });
	});

	it("exports a session's built-in tool calls as their presentations", async () => {
		const session = SessionManager.inMemory("/workspace");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: `echo '${XSS}'` } }],
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
			timestamp: 1,
		};
		await session.logWriter.appendMessage(assistant);
		await session.logWriter.appendMessage({
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "bash",
			content: [{ type: "text", text: `${XSS}\nsecond line` }],
			isError: false,
			timestamp: 2,
		});
		const { presentedTools } = presentSessionEntries(session.getEntries(), BUILTIN_PRESENTERS, "/workspace");
		const presented = presentedTools?.["call-1"];
		expect(presented?.title).toContain("$ ");
		expect(presented?.title).toContain("&lt;script&gt;");
		expect(presented?.expanded).toContain("&lt;script&gt;");
		expect(presented?.expanded).toContain("second line");
		const { text, ...html } = presented ?? { text: "" };
		expect(JSON.stringify(html)).not.toContain("<script>");
		// The session tree names the call by its title, as plain text the template escapes.
		expect(text).toBe(`$ echo '${XSS}'`);
	});

	it("exports every tool call: one without a presenter generically, one its presentation hides as nothing", async () => {
		const session = SessionManager.inMemory("/workspace");
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "custom", name: "custom_tool", arguments: { note: XSS } },
				{ type: "toolCall", id: "quiet", name: "quiet_tool", arguments: {} },
			],
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
			timestamp: 1,
		};
		await session.logWriter.appendMessage(assistant);
		await session.logWriter.appendMessage({
			role: "toolResult",
			toolCallId: "custom",
			toolName: "custom_tool",
			content: [{ type: "text", text: "custom output" }],
			isError: false,
			timestamp: 2,
		});
		const presenters = {
			generation: 0,
			tool: (name: string) =>
				name === "quiet_tool"
					? { present: () => ({ title: "quiet", hidden: true }), policy: HOST_UI_POLICY }
					: BUILTIN_PRESENTERS.tool(name),
			message: BUILTIN_PRESENTERS.message,
		};
		const { presentedTools } = presentSessionEntries(session.getEntries(), presenters, "/workspace");
		expect(presentedTools?.custom?.title).toContain("custom_tool");
		expect(presentedTools?.custom?.expanded).toContain("custom output");
		expect(presentedTools?.custom?.expanded).toContain("&lt;script&gt;");
		expect(presentedTools?.quiet).toBeNull();
	});

	it("exports the host's work notices and reviews as their presentations", async () => {
		const session = SessionManager.inMemory("/workspace");
		const notice = await session.logWriter.appendCustomMessageEntry(
			"work_notice",
			"Build (job job_1) completed.\n## Done\n- **ok**",
			true,
			{ workId: "job_1", kind: "job", title: "Build", outcome: "completed" },
		);
		const review = await session.logWriter.appendCustomMessageEntry("review", "Full review", true, {
			summary: "Compact review",
		});
		const { presentedMessages } = presentSessionEntries(session.getEntries(), BUILTIN_PRESENTERS, "/workspace");
		expect(presentedMessages?.[notice]?.expanded).toContain("Build (job job_1) completed.");
		expect(presentedMessages?.[notice]?.expanded).toContain('class="ui-markdown"');
		expect(presentedMessages?.[review]?.collapsed).toContain("Compact review");
		expect(presentedMessages?.[review]?.expanded).toContain("Full review");
	});

	it("exports how long each timed step ran", () => {
		const html = uiNodeHtml({
			type: "progress",
			kind: "steps",
			steps: [
				{ label: "first", status: "done", startedAt: 1_000, endedAt: 3_500 },
				{ label: "second", status: "active", startedAt: 1_000 },
			],
		});
		expect(html).toContain('[done] first <span class="ui-token-muted">2.5s</span>');
		expect(html).toContain("[active] second</div>");
	});
});
