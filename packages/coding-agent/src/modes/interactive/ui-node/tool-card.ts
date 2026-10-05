/**
 * The generic tool card (RFC §8.3, Q9): a tool call renders from its
 * presentation, the `UiNode` data its tool presents, inside chrome the client
 * owns: the state badge, elapsed time, collapsed or expanded content, the
 * actions, and the result's images. Collapsed, the card shows the summary;
 * expanded, the body, or the summary when there is no body. A hidden
 * presentation renders nothing.
 *
 * A scaffold: tool calls render through `ToolExecutionComponent` until tools
 * present themselves.
 */

import type { UiImageNode, UiNode, UiNodeAction, UiNodeStyledText } from "@hansjm10/volt-protocol";
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
import { keyHint } from "../components/keybinding-hints.ts";
import { createUiNodeView, type UiNodeViewOptions } from "./registry.ts";
import { TUI_SEMANTIC_THEME } from "./semantic-theme.ts";

export type ToolCardState = "pending" | "running" | "done";

/** What a tool presents for one call. */
export interface ToolCardPresentation {
	readonly title: UiNodeStyledText;
	/** What the call is doing now, after the state badge. */
	readonly activity?: UiNodeStyledText;
	readonly summary?: readonly UiNode[];
	readonly body?: readonly UiNode[];
	readonly actions?: readonly UiNodeAction[];
	readonly hidden?: boolean;
	/** The presentation shows its own duration, so the chrome does not. */
	readonly showsDuration?: boolean;
}

export interface ToolCardImage {
	readonly data: string;
	readonly mimeType: UiImageNode["mimeType"];
}

export interface ToolCardProps {
	readonly presentation: ToolCardPresentation;
	readonly state: ToolCardState;
	/** The call is done and its result is an error. */
	readonly isError?: boolean;
	readonly expanded?: boolean;
	/** How long the call ran, or runs so far. */
	readonly elapsedMs?: number;
	/** The result's images. */
	readonly images?: readonly ToolCardImage[];
}

/** A finished call shows its duration from this long on. */
const DURATION_DISPLAY_THRESHOLD_MS = 1000;

function stateBadge(state: ToolCardState, isError: boolean): string {
	if (state === "done") return isError ? theme.fg("error", "[failure]") : theme.fg("success", "[success]");
	return state === "running" ? theme.fg("warning", "[running]") : theme.fg("muted", "[pending]");
}

/** One tool call: its presentation in the client's chrome. */
export class ToolCard implements Component {
	private props: ToolCardProps;
	private readonly content: ViewReconciler<UiNode>;
	/** The actions and images below the content. */
	private readonly extras: ViewReconciler<UiNode>;

	constructor(props: ToolCardProps, options: UiNodeViewOptions = {}) {
		this.props = props;
		this.content = createUiNodeView(options);
		this.extras = createUiNodeView(options);
		this.sync();
	}

	setProps(props: ToolCardProps): void {
		this.props = props;
		this.sync();
	}

	invalidate(): void {
		this.content.invalidate();
		this.extras.invalidate();
	}

	dispose(): void {
		this.content.dispose();
		this.extras.dispose();
	}

	render(width: number): RenderFrame {
		const { presentation, expanded } = this.props;
		if (presentation.hidden) return createRenderFrame([]);
		const inner = Math.max(1, width - 2);
		const frames = [createRenderFrame([this.header(inner)]), this.content.render(inner)];
		if (!expanded && (presentation.body?.length ?? 0) > 0) {
			frames.push(createRenderFrame([truncateToWidth(keyHint("app.tools.expand", "to expand"), inner, "")]));
		}
		frames.push(this.extras.render(inner));
		return concatRenderFrames([createRenderFrame([""]), prefixRenderFrame(concatRenderFrames(frames), " ")]);
	}

	private sync(): void {
		const { presentation, expanded, images = [] } = this.props;
		const shown = expanded && presentation.body !== undefined ? presentation.body : (presentation.summary ?? []);
		this.content.update(shown);
		const extras: UiNode[] = [];
		if (presentation.actions && presentation.actions.length > 0) {
			extras.push({ type: "actions", key: "actions", actions: [...presentation.actions] });
		}
		images.forEach((image, index) => {
			extras.push({ type: "image", key: `image:${index}`, mimeType: image.mimeType, data: image.data });
		});
		this.extras.update(extras);
	}

	/** The title, then the state badge, activity, and elapsed time; the title gives way first. */
	private header(width: number): string {
		const { presentation, state, isError = false, elapsedMs } = this.props;
		const meta = [stateBadge(state, isError)];
		if (presentation.activity !== undefined) {
			meta.push(renderStyledText(presentation.activity, TUI_SEMANTIC_THEME, "muted").replace(/\n/g, " "));
		}
		const showsElapsed =
			elapsedMs !== undefined &&
			!presentation.showsDuration &&
			(state === "running" || elapsedMs >= DURATION_DISPLAY_THRESHOLD_MS);
		if (showsElapsed) meta.push(theme.fg("dim", `(${formatDuration(elapsedMs)})`));
		const suffix = meta.join(" ");
		const titleWidth = Math.min(styledTextWidth(presentation.title), Math.max(1, width - visibleWidth(suffix) - 1));
		const title = TUI_SEMANTIC_THEME.bold(truncateStyledText(presentation.title, titleWidth, TUI_SEMANTIC_THEME));
		return truncateToWidth(`${title} ${suffix}`, width, "…");
	}
}
