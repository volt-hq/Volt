/**
 * The generic tool card (RFC §8.3, Q9): a tool call renders from its
 * presentation, the `UiNode` data its tool presents, inside chrome the client
 * owns: the state glyph before the title, elapsed time (when the presentation
 * `showsDuration`), collapsed or expanded content, the actions, the result's
 * images, and the work the call started (a background job), live. Work the
 * presentation binds an `open_work` or `cancel_work` action to is the
 * presentation's to show, and the card does not list it again. Collapsed, the
 * card shows the summary; expanded, the body, or the summary when there is no
 * body. The content sits under the title, past the glyph, in the theme's tool
 * output colors, so it stands apart from the assistant's text. A hidden
 * presentation renders nothing.
 */

import {
	type ToolPresentation,
	UI_NODE_LINE_MAX_CHARS,
	UI_NODE_TERMINAL_MAX_LINES,
	type UiImageNode,
	type UiNode,
	type UiNodeAction,
	type UiNodeStyledText,
	type UiNodeToken,
} from "@hansjm10/volt-protocol";
import {
	type Component,
	concatRenderFrames,
	createRenderFrame,
	prefixRenderFrame,
	type RenderFrame,
	renderStyledText,
	styledTextWidth,
	truncateStyledText,
	truncateToWidth,
	type ViewReconciler,
	visibleWidth,
} from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { formatDuration } from "../../../core/tools/render-utils.ts";
import { stripTerminalControls } from "../../../core/ui/ansi-tokens.ts";
import { keyHint } from "../components/keybinding-hints.ts";
import { createUiNodeView, isRenderVolatile, type UiNodeViewOptions } from "./registry.ts";
import { TOOL_OUTPUT_SEMANTIC_THEME, TOOL_TITLE_SEMANTIC_THEME, TUI_SEMANTIC_THEME } from "./semantic-theme.ts";

export type ToolCardState = "pending" | "running" | "done";

export interface ToolCardImage {
	readonly data: string;
	readonly mimeType: UiImageNode["mimeType"];
}

/** A work item the call started, as the client folds it: shown live under the call. */
export interface ToolCardWork {
	readonly workId: string;
	readonly title: string;
	/** Its state or outcome: `running`, `cancelling`, `suspended`, `completed`, `failed`, `cancelled`, `interrupted`. */
	readonly status: string;
	/** How long it ran, or runs so far. */
	readonly elapsedMs?: number;
	/** Its latest progress text, or its result's summary or error once it ended. */
	readonly text?: string;
	/** Its kind's detail. */
	readonly detail?: UiNode;
	/** Its newest output: collapsed, the card shows the last lines of it; expanded, all. */
	readonly output?: string;
}

export interface ToolCardProps {
	readonly presentation: ToolPresentation;
	readonly state: ToolCardState;
	/** The call is done and its result is an error. */
	readonly isError?: boolean;
	readonly expanded?: boolean;
	/** How long the call ran, or runs so far; shown when the presentation `showsDuration`. */
	readonly elapsedMs?: number;
	/** The result's images. */
	readonly images?: readonly ToolCardImage[];
	/** The work the call started. */
	readonly work?: readonly ToolCardWork[];
	/** Collapsed with a body, the card says how to expand it. True by default. */
	readonly expandHint?: boolean;
}

/** Narrowest title, in cells, the header keeps beside the activity and elapsed time before it moves them below. */
const HEADER_TITLE_MIN_WIDTH = 16;

/** What the content is indented by: it sits under the title, past the state glyph. */
const CONTENT_INDENT = "  ";

/** A finished call whose presentation shows its duration shows it from this long on. */
const DURATION_DISPLAY_THRESHOLD_MS = 1000;

const WORK_STATUS_TOKENS: Readonly<Record<string, UiNodeToken>> = {
	running: "warning",
	cancelling: "warning",
	suspended: "muted",
	completed: "success",
	failed: "error",
	cancelled: "muted",
	interrupted: "muted",
};

/** The call's state as a glyph, as steps and work items show theirs. */
function stateGlyph(state: ToolCardState, isError: boolean): string {
	if (state === "done") return isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	return state === "running" ? theme.fg("accent", "●") : theme.fg("muted", "○");
}

/** Output lines a collapsed card shows of the work its call started. */
const WORK_OUTPUT_PREVIEW_LINES = 3;

/** Work output as terminal lines: collapsed, its last non-empty lines; expanded, every line. */
function workOutput(work: ToolCardWork, expanded: boolean): UiNode[] {
	const lines = (work.output ?? "").replace(/\s+$/, "").split("\n");
	if (lines.length === 1 && lines[0] === "") return [];
	const shown = expanded
		? lines.slice(-UI_NODE_TERMINAL_MAX_LINES)
		: lines.filter((line) => line.trim()).slice(-WORK_OUTPUT_PREVIEW_LINES);
	const omitted = lines.length - shown.length;
	return [
		{
			type: "terminal",
			key: `work:${work.workId}:output`,
			lines: shown.map((line) => stripTerminalControls(line).slice(0, UI_NODE_LINE_MAX_CHARS)),
			...(omitted > 0 ? { omittedLines: omitted } : {}),
		},
	];
}

/** A work item the call started, as nodes: its state, title, and time on one line, then its text, detail, and output. */
function workNodes(work: ToolCardWork, expanded: boolean): UiNode[] {
	const line: UiNodeStyledText = [
		{
			text: work.status.charAt(0).toUpperCase() + work.status.slice(1),
			token: WORK_STATUS_TOKENS[work.status] ?? "muted",
		},
		{ text: ` · ${work.title.replace(/\s+/g, " ").trim()}` },
		...(work.elapsedMs === undefined
			? []
			: [{ text: ` · ${formatDuration(work.elapsedMs)}`, token: "muted" as const }]),
	];
	return [
		{ type: "text", key: `work:${work.workId}`, text: line },
		...(work.text === undefined || work.text.trim() === "" || work.output?.trim()
			? []
			: [
					{
						type: "text" as const,
						key: `work:${work.workId}:text`,
						text: work.text.trim(),
						token: "muted" as const,
					},
				]),
		...(work.detail === undefined ? [] : [{ ...work.detail, key: `work:${work.workId}:detail` }]),
		...workOutput(work, expanded),
	];
}

/** The work ids a presentation's `open_work` and `cancel_work` actions name, in any of its trees. */
function boundWorkIds(presentation: ToolPresentation): Set<string> {
	const ids = new Set<string>();
	const visitActions = (actions: readonly UiNodeAction[] | undefined): void => {
		for (const action of actions ?? []) {
			const workId = action.intent.input?.workId;
			if (
				(action.intent.type === "open_work" || action.intent.type === "cancel_work") &&
				typeof workId === "string"
			) {
				ids.add(workId);
			}
		}
	};
	const visit = (nodes: readonly UiNode[] | undefined): void => {
		for (const node of nodes ?? []) {
			if (node.type === "actions") visitActions(node.actions);
			else if (node.type === "list") visit(node.items);
			else if (node.type === "card") {
				visitActions(node.actions);
				for (const section of node.sections ?? []) visit(section.children);
			}
		}
	};
	visitActions(presentation.actions);
	visit(presentation.summary);
	visit(presentation.body);
	return ids;
}

/**
 * One tool call: its presentation in the client's chrome.
 *
 * A transcript renders every card on every frame, and a card's output changes only when its props do. So the card
 * keeps the frame it last rendered and returns it for the same width until `setProps` or `invalidate`, except
 * while its nodes can render differently on their own (`isRenderVolatile`).
 */
export class ToolCard implements Component {
	private props: ToolCardProps;
	private readonly content: ViewReconciler<UiNode>;
	/** The actions, images, and work below the content. */
	private readonly extras: ViewReconciler<UiNode>;
	private cache: { width: number; frame: RenderFrame } | undefined;
	/** The nodes shown can render differently from one render to the next, so no frame is kept. */
	private volatile = false;

	constructor(props: ToolCardProps, options: UiNodeViewOptions = {}) {
		this.props = props;
		const views = { semanticTheme: TOOL_OUTPUT_SEMANTIC_THEME, ...options };
		this.content = createUiNodeView({ ...views, fullTerminals: true });
		this.extras = createUiNodeView(views);
		this.sync();
	}

	setProps(props: ToolCardProps): void {
		this.props = props;
		this.sync();
	}

	invalidate(): void {
		this.cache = undefined;
		this.content.invalidate();
		this.extras.invalidate();
	}

	dispose(): void {
		this.cache = undefined;
		this.content.dispose();
		this.extras.dispose();
	}

	render(width: number): RenderFrame {
		if (this.cache?.width === width) return this.cache.frame;
		const frame = this.renderFrame(width);
		if (!this.volatile) this.cache = { width, frame };
		return frame;
	}

	private renderFrame(width: number): RenderFrame {
		const { presentation, expanded, expandHint = true } = this.props;
		if (presentation.hidden) return createRenderFrame([]);
		// A column of margin on either side; the content sits under the title.
		const inner = Math.max(1, width - 2);
		const contentWidth = Math.max(1, inner - CONTENT_INDENT.length);
		const content = [this.content.render(contentWidth)];
		if (expandHint && !expanded && (presentation.body?.length ?? 0) > 0) {
			content.push(createRenderFrame([truncateToWidth(keyHint("app.tools.expand", "to expand"), contentWidth, "")]));
		}
		content.push(this.extras.render(contentWidth));
		const card = concatRenderFrames([
			createRenderFrame(this.header(inner)),
			prefixRenderFrame(concatRenderFrames(content), CONTENT_INDENT),
		]);
		return concatRenderFrames([createRenderFrame([""]), prefixRenderFrame(card, " ")]);
	}

	private sync(): void {
		this.cache = undefined;
		const { presentation, expanded, images = [], work = [] } = this.props;
		const shown = expanded && presentation.body !== undefined ? presentation.body : (presentation.summary ?? []);
		this.content.update(shown);
		const extras: UiNode[] = [];
		if (presentation.actions && presentation.actions.length > 0) {
			extras.push({ type: "actions", key: "actions", actions: [...presentation.actions] });
		}
		images.forEach((image, index) => {
			extras.push({ type: "image", key: `image:${index}`, mimeType: image.mimeType, data: image.data });
		});
		const presented = boundWorkIds(presentation);
		for (const item of work) if (!presented.has(item.workId)) extras.push(...workNodes(item, expanded === true));
		this.extras.update(extras);
		this.volatile = isRenderVolatile([...shown, ...extras]);
	}

	/** The state glyph and title, then the activity and elapsed time; the title gives way first. */
	private header(width: number): string[] {
		const { presentation, state, isError = false, elapsedMs } = this.props;
		const glyph = `${stateGlyph(state, isError)} `;
		const titleWidth = Math.max(1, width - visibleWidth(glyph));
		const meta: string[] = [];
		if (presentation.activity !== undefined) {
			meta.push(renderStyledText(presentation.activity, TUI_SEMANTIC_THEME, "muted").replace(/\n/g, " "));
		}
		const showsElapsed =
			presentation.showsDuration === true &&
			elapsedMs !== undefined &&
			(state === "running" || elapsedMs >= DURATION_DISPLAY_THRESHOLD_MS);
		if (showsElapsed) meta.push(theme.fg("dim", `(${formatDuration(elapsedMs)})`));
		if (meta.length === 0) return [truncateToWidth(glyph + this.title(titleWidth), width, "…")];
		const suffix = meta.join(" ");
		const fullWidth = styledTextWidth(presentation.title);
		const room = titleWidth - visibleWidth(suffix) - 1;
		// Where the title would shrink to almost nothing, the rest goes on its own line, so it never hides the title.
		if (room < Math.min(fullWidth, HEADER_TITLE_MIN_WIDTH)) {
			return [
				truncateToWidth(glyph + this.title(titleWidth), width, "…"),
				truncateToWidth(CONTENT_INDENT + suffix, width, "…"),
			];
		}
		const title = this.title(Math.min(fullWidth, Math.max(1, room)));
		return [truncateToWidth(`${glyph}${title} ${suffix}`, width, "…")];
	}

	/** The title within `width`: styled as its spans say, or bold when it is plain text. */
	private title(width: number): string {
		const { title } = this.props.presentation;
		const text = truncateStyledText(title, width, TOOL_TITLE_SEMANTIC_THEME);
		return typeof title === "string" ? TOOL_TITLE_SEMANTIC_THEME.bold(text) : text;
	}
}
