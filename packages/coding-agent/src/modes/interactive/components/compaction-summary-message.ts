import { Box, Markdown, type MarkdownTheme, Spacer, Text } from "@hansjm10/volt-tui";
import type { CompactionSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../../../core/theme/runtime.ts";
import { type CompactionOutcome, compactionHeadline, compactionNote } from "../compaction-outcome.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a compaction message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class CompactionSummaryMessageComponent extends Box {
	private expanded = false;
	private message: CompactionSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private outcome: CompactionOutcome;

	constructor(
		message: CompactionSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outcome: CompactionOutcome = {},
	) {
		super(1, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.outcome = outcome;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const headline = compactionHeadline(this.message.tokensBefore, this.outcome);
		const note = compactionNote(this.outcome);
		const label = theme.fg("customMessageLabel", `\x1b[1m[compaction]\x1b[22m`);
		this.addChild(new Text(label, 0, 0));
		this.addChild(new Spacer(1));

		if (this.expanded) {
			const header = `**${headline}**\n\n${note === undefined ? "" : `${note}\n\n`}`;
			this.addChild(
				new Markdown(header + this.message.summary, 0, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		} else {
			this.addChild(
				new Text(
					theme.fg("customMessageText", `${headline} (`) +
						theme.fg("dim", keyText("app.tools.expand")) +
						theme.fg("customMessageText", " to expand)") +
						(note === undefined ? "" : `\n${theme.fg("customMessageText", note)}`),
					0,
					0,
				),
			);
		}
	}
}
