/**
 * `UiNode` data as HTML for the session export (RFC §8.3): tool calls and
 * custom messages export as their presentations, the same data every client
 * renders. All text is escaped; styling is a closed set of semantic token
 * classes; images embed only the four image types as base64 data URLs; and
 * actions and forms export as inert text, so exported HTML runs nothing.
 */

import type {
	MessagePresentation,
	ToolPresentation,
	UiNode,
	UiNodeStyledText,
	UiNodeToken,
	UiTreeItem,
} from "@hansjm10/volt-protocol";

const TOKENS: ReadonlySet<string> = new Set(["text", "muted", "accent", "success", "warning", "error", "info"]);
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const LANGUAGE = /^[A-Za-z0-9_+#.-]{1,64}$/;

/** Text escaped for HTML element content and quoted attribute values. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function tokenClass(token: UiNodeToken | undefined): string {
	return token !== undefined && TOKENS.has(token) ? ` ui-token-${token}` : "";
}

/** Styled text as escaped spans: each span's token as a class, and its emphasis as elements. */
export function styledTextHtml(text: UiNodeStyledText, token?: UiNodeToken): string {
	const spans = typeof text === "string" ? [{ text }] : text;
	const html = spans
		.map((span) => {
			let inner = escapeHtml(span.text);
			if ("code" in span && span.code) inner = `<code>${inner}</code>`;
			if ("underline" in span && span.underline) inner = `<u>${inner}</u>`;
			if ("italic" in span && span.italic) inner = `<em>${inner}</em>`;
			if ("bold" in span && span.bold) inner = `<strong>${inner}</strong>`;
			const spanToken = "token" in span ? span.token : undefined;
			return spanToken === undefined ? inner : `<span class="${tokenClass(spanToken).trim()}">${inner}</span>`;
		})
		.join("");
	return token === undefined ? html : `<span class="${tokenClass(token).trim()}">${html}</span>`;
}

function treeHtml(items: readonly UiTreeItem[]): string {
	if (items.length === 0) return "";
	const rendered = items
		.map(
			(item) =>
				`<li>${styledTextHtml(item.label)}${item.description === undefined ? "" : ` <span class="ui-token-muted">${styledTextHtml(item.description)}</span>`}${treeHtml(item.children ?? [])}</li>`,
		)
		.join("");
	return `<ul class="ui-tree">${rendered}</ul>`;
}

/** One node as HTML. */
export function uiNodeHtml(node: UiNode): string {
	switch (node.type) {
		case "text":
			return `<div class="ui-text${tokenClass(node.token)}">${styledTextHtml(node.text)}</div>`;
		case "markdown":
			return `<div class="ui-markdown">${escapeHtml(node.markdown)}</div>`;
		case "list": {
			const tag = node.ordered ? "ol" : "ul";
			return `<${tag} class="ui-list">${node.items.map((item) => `<li>${uiNodeHtml(item)}</li>`).join("")}</${tag}>`;
		}
		case "table": {
			const head = node.columns.map((column) => `<th>${styledTextHtml(column.header)}</th>`).join("");
			const rows =
				node.rows.length === 0 && node.emptyText !== undefined
					? `<tr><td colspan="${node.columns.length}">${styledTextHtml(node.emptyText)}</td></tr>`
					: node.rows
							.map((row) => `<tr>${row.cells.map((cell) => `<td>${styledTextHtml(cell)}</td>`).join("")}</tr>`)
							.join("");
			return `<table class="ui-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
		}
		case "keyValue":
			return `<dl class="ui-key-value">${node.items
				.map((item) => `<dt>${styledTextHtml(item.label)}</dt><dd>${styledTextHtml(item.value)}</dd>`)
				.join("")}</dl>`;
		case "progress":
			if (node.kind === "determinate") {
				const max = node.max ?? 1;
				const percent = Math.round(Math.min(1, Math.max(0, node.value / max)) * 100);
				const label = node.label === undefined ? "" : `${styledTextHtml(node.label)} `;
				return `<div class="ui-progress${tokenClass(node.token)}">${label}${percent}%</div>`;
			}
			return `<div class="ui-steps">${node.title === undefined ? "" : `<div class="ui-text">${styledTextHtml(node.title)}</div>`}${node.steps
				.map(
					(step) =>
						`<div class="ui-step ui-step-${escapeHtml(step.status)}">[${escapeHtml(step.status)}] ${styledTextHtml(step.label)}${step.detail === undefined ? "" : ` <span class="ui-token-muted">${styledTextHtml(step.detail)}</span>`}</div>`,
				)
				.join("")}</div>`;
		case "form":
			return `<div class="ui-form">${node.title === undefined ? "" : `<div class="ui-text">${styledTextHtml(node.title)}</div>`}${node.fields
				.map((field) => `<div class="ui-form-field">${escapeHtml(field.label)}</div>`)
				.join("")}</div>`;
		case "actions":
			return `<div class="ui-actions">${node.actions.map((action) => `<span class="ui-action">[${escapeHtml(action.label)}]</span>`).join(" ")}</div>`;
		case "card": {
			const badges = (node.badges ?? [])
				.map((badge) => ` <span class="ui-badge${tokenClass(badge.token)}">${escapeHtml(badge.label)}</span>`)
				.join("");
			const sections = (node.sections ?? [])
				.map(
					(section) =>
						`<div class="ui-card-section">${section.title === undefined ? "" : `<div class="ui-card-section-title">${styledTextHtml(section.title)}</div>`}${uiNodesHtml(section.children)}</div>`,
				)
				.join("");
			const actions = (node.actions ?? [])
				.map((action) => `<span class="ui-action">[${escapeHtml(action.label)}]</span>`)
				.join(" ");
			return `<div class="ui-card"><div class="ui-card-title${tokenClass(node.token)}">${styledTextHtml(node.title)}${badges}</div>${sections}${actions ? `<div class="ui-actions">${actions}</div>` : ""}</div>`;
		}
		case "diff": {
			const path = node.path === undefined ? "" : `<div class="ui-diff-path">${escapeHtml(node.path)}</div>`;
			const lines = node.lines
				.map((line) => {
					const cls =
						line.kind === "add"
							? "diff-added"
							: line.kind === "remove"
								? "diff-removed"
								: line.kind === "context"
									? "diff-context"
									: "ui-token-muted";
					const number = node.lineNumbers ? (line.kind === "add" ? line.newLine : line.oldLine) : undefined;
					const prefix = line.kind === "add" ? "+" : line.kind === "remove" ? "-" : " ";
					const gutter = node.lineNumbers ? `${number === undefined ? "" : String(number)} ` : "";
					return `<div class="${cls}">${escapeHtml(`${prefix}${gutter}${line.text}`)}</div>`;
				})
				.join("");
			return `<div class="tool-diff ui-diff">${path}${lines}</div>`;
		}
		case "terminal": {
			const title = node.title === undefined ? "" : `<div class="ui-text">${styledTextHtml(node.title)}</div>`;
			const omitted =
				node.omittedLines === undefined || node.omittedLines === 0
					? ""
					: `<div class="ui-token-muted">… ${node.omittedLines} earlier lines</div>`;
			const lines = node.lines.map((line) => `<div>${styledTextHtml(line) || "&#8203;"}</div>`).join("");
			return `<div class="ui-terminal">${title}${omitted}${lines}</div>`;
		}
		case "code": {
			const title = node.title === undefined ? "" : `<div class="ui-text">${styledTextHtml(node.title)}</div>`;
			const language =
				node.language !== undefined && LANGUAGE.test(node.language) ? ` class="language-${node.language}"` : "";
			return `${title}<pre class="ui-code"><code${language}>${escapeHtml(node.code)}</code></pre>`;
		}
		case "image":
			if (!IMAGE_MIME_TYPES.has(node.mimeType) || !BASE64.test(node.data)) return "";
			return `<img class="tool-image" src="data:${node.mimeType};base64,${node.data}" alt="${escapeHtml(node.alt ?? "")}" />`;
		case "tree":
			return treeHtml(node.items);
	}
}

/** Sibling nodes as HTML. */
export function uiNodesHtml(nodes: readonly UiNode[]): string {
	return nodes.map(uiNodeHtml).join("");
}

/** A presented tool call as export HTML: its title, and its collapsed and expanded content. */
export interface PresentedHtml {
	readonly title: string;
	readonly collapsed: string;
	readonly expanded: string;
}

/** A tool presentation as export HTML; hidden calls export nothing. */
export function toolPresentationHtml(presentation: ToolPresentation): PresentedHtml | undefined {
	if (presentation.hidden) return undefined;
	const summary = uiNodesHtml(presentation.summary ?? []);
	const body = presentation.body === undefined ? summary : uiNodesHtml(presentation.body);
	const activity =
		presentation.activity === undefined
			? ""
			: ` <span class="ui-token-muted">${styledTextHtml(presentation.activity)}</span>`;
	return { title: `${styledTextHtml(presentation.title)}${activity}`, collapsed: summary, expanded: body };
}

/** A message presentation as export HTML. */
export function messagePresentationHtml(presentation: MessagePresentation): PresentedHtml {
	const body = uiNodesHtml(presentation.body);
	return {
		title: presentation.title === undefined ? "" : styledTextHtml(presentation.title),
		collapsed: presentation.summary === undefined ? body : uiNodesHtml(presentation.summary),
		expanded: body,
	};
}
