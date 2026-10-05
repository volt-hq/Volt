/**
 * A custom message drawn from its presentation (RFC §8.3): the `UiNode`
 * data its type's message presenter returned, under the message's label.
 * Collapsed, it shows the summary when there is one; expanded, the body.
 */

import type { MessagePresentation, UiNode } from "@hansjm10/volt-protocol";
import {
	type Component,
	concatRenderFrames,
	createRenderFrame,
	prefixRenderFrame,
	type RenderFrame,
	truncateStyledText,
	truncateToWidth,
	type ViewReconciler,
} from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { createUiNodeView } from "../ui-node/registry.ts";
import { TUI_SEMANTIC_THEME } from "../ui-node/semantic-theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export class PresentedMessageComponent implements Component {
	private readonly presentation: MessagePresentation;
	private readonly customType: string;
	private readonly content: ViewReconciler<UiNode> = createUiNodeView({ fullTerminals: true });
	private expanded = false;

	constructor(customType: string, presentation: MessagePresentation) {
		this.customType = customType;
		this.presentation = presentation;
		this.sync();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.sync();
	}

	invalidate(): void {
		this.content.invalidate();
	}

	dispose(): void {
		this.content.dispose();
	}

	render(width: number): RenderFrame {
		const inner = Math.max(1, width - 2);
		const label = this.presentation.title
			? TUI_SEMANTIC_THEME.bold(truncateStyledText(this.presentation.title, inner, TUI_SEMANTIC_THEME))
			: theme.bg("customMessageBg", theme.fg("customMessageLabel", theme.bold(` ${this.customType} `)));
		const frames = [createRenderFrame([truncateToWidth(label, inner, "…")]), this.content.render(inner)];
		if (!this.expanded && this.presentation.summary !== undefined) {
			frames.push(createRenderFrame([truncateToWidth(keyHint("app.tools.expand", "to expand"), inner, "")]));
		}
		return concatRenderFrames([createRenderFrame([""]), prefixRenderFrame(concatRenderFrames(frames), " ")]);
	}

	private sync(): void {
		const { summary, body } = this.presentation;
		this.content.update(!this.expanded && summary !== undefined ? summary : body);
	}
}
