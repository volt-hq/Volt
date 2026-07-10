import { type Component, Container, Markdown, type MarkdownTheme, Spacer } from "@earendil-works/volt-tui";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class UserMessageRail implements Component {
	private content: Component;

	constructor(content: Component) {
		this.content = content;
	}

	render(width: number): string[] {
		if (width <= 2) return this.content.render(width);
		const prefix = `${theme.fg("borderAccent", "│")} `;
		return this.content.render(width - 2).map((line) => prefix + line);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(
			new UserMessageRail(
				new Markdown(
					text,
					0,
					0,
					markdownTheme,
					{
						color: (content: string) => theme.fg("userMessageText", content),
					},
					{ preserveOrderedListMarkers: true },
				),
			),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
