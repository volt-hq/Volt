/**
 * A custom message in the transcript (RFC §8.3): drawn from its presentation,
 * the `UiNode` data its type's message presenter returns (the host's for its
 * own types, an extension's for the types it registered), under the
 * message's label. Collapsed, it shows the summary when there is one;
 * expanded, the body. A message without a presentation shows its label and
 * its text as Markdown. The message presents with the presenters there are
 * when it presents: after extensions are enabled or disabled,
 * `refreshPresentation()` presents it again, so a disabled extension's
 * presenter no longer draws it.
 */

import type { JsonValue, TextContent } from "@hansjm10/volt-ai";
import type { MessagePresentation, UiNode } from "@hansjm10/volt-protocol";
import {
	type Component,
	concatRenderFrames,
	createRenderFrame,
	Markdown,
	type MarkdownTheme,
	prefixRenderFrame,
	type RenderFrame,
	Spacer,
	Text,
	truncateStyledText,
	truncateToWidth,
	type ViewReconciler,
} from "@hansjm10/volt-tui";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";
import { createUiNodeView } from "../ui-node/registry.ts";
import { TUI_SEMANTIC_THEME } from "../ui-node/semantic-theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export class PresentedMessageComponent implements Component {
	private readonly message: CustomMessage<JsonValue>;
	private readonly present: () => MessagePresentation | undefined;
	private readonly markdownTheme: MarkdownTheme;
	private readonly content: ViewReconciler<UiNode> = createUiNodeView({ fullTerminals: true });
	private presentation: MessagePresentation | undefined;
	/** The label and Markdown text of a message without a presentation, built when first drawn. */
	private fallback: { readonly label: Text; readonly text: Markdown } | undefined;
	private expanded = false;

	constructor(
		message: CustomMessage<JsonValue>,
		present: () => MessagePresentation | undefined,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		this.message = message;
		this.present = present;
		this.markdownTheme = markdownTheme;
		this.presentation = present();
		this.sync();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.sync();
	}

	/** Present the message again with the presenters there are now: extensions were enabled or disabled. */
	refreshPresentation(): void {
		this.presentation = this.present();
		this.sync();
	}

	invalidate(): void {
		this.content.invalidate();
		this.fallback = undefined;
	}

	dispose(): void {
		this.content.dispose();
	}

	render(width: number): RenderFrame {
		if (this.presentation === undefined) return this.renderFallback(width);
		const inner = Math.max(1, width - 2);
		const label = this.presentation.title
			? TUI_SEMANTIC_THEME.bold(truncateStyledText(this.presentation.title, inner, TUI_SEMANTIC_THEME))
			: this.label();
		const frames = [createRenderFrame([truncateToWidth(label, inner, "…")]), this.content.render(inner)];
		if (!this.expanded && this.presentation.summary !== undefined) {
			frames.push(createRenderFrame([truncateToWidth(keyHint("app.tools.expand", "to expand"), inner, "")]));
		}
		return concatRenderFrames([createRenderFrame([""]), prefixRenderFrame(concatRenderFrames(frames), " ")]);
	}

	private label(): string {
		return theme.bg("customMessageBg", theme.fg("customMessageLabel", theme.bold(` ${this.message.customType} `)));
	}

	private renderFallback(width: number): RenderFrame {
		this.fallback ??= {
			label: new Text(this.label(), 1, 0),
			text: new Markdown(this.text(), 1, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		};
		return concatRenderFrames([
			new Spacer(1).render(width),
			this.fallback.label.render(width),
			this.fallback.text.render(width),
		]);
	}

	private text(): string {
		const { content } = this.message;
		return typeof content === "string"
			? content
			: content
					.filter((part): part is TextContent => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	}

	private sync(): void {
		this.fallback = undefined;
		if (this.presentation === undefined) {
			this.content.update([]);
			return;
		}
		const { summary, body } = this.presentation;
		this.content.update(!this.expanded && summary !== undefined ? summary : body);
	}
}
