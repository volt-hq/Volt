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
		expect(JSON.stringify(presented)).not.toContain("<script>");
	});
});
