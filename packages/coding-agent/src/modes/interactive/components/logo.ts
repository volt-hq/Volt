import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/volt-tui";
import { APP_NAME } from "../../../config.ts";
import { theme } from "../../../core/theme/runtime.ts";

const VOLT_WORDMARK = [
	"__          __   ______    _        _________ ",
	"\\ \\        / /  /  __  \\  | |      |___   ___|",
	" \\ \\      / /  |  /  \\  | | |          | |    ",
	"  \\ \\    / /   | |    | | | |          | |    ",
	"   \\ \\  / /    | |    | | | |          | |    ",
	"    \\ \\/ /     |  \\__/  | | |____      | |    ",
	"      \\/        \\______/  |______|     |_|   ",
];

/**
 * Render the startup logo: an ASCII wordmark for "volt" with the version
 * appended, or a plain text logo when the app was renamed via voltConfig.name.
 */
export function renderLogo(version: string): string {
	if (APP_NAME !== "volt") {
		return theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${version}`);
	}
	const lines = VOLT_WORDMARK.map((line) => theme.bold(theme.fg("accent", line)));
	lines[lines.length - 1] += theme.fg("dim", ` v${version}`);
	return lines.join("\n");
}

export interface StartupHeaderOptions {
	version: string;
	compactInstructions: string;
	expandedInstructions: string;
	expansionHint: string;
	onboarding: string;
	expanded?: boolean;
}

/** Responsive Volt startup lockup and command deck. */
export class StartupHeaderComponent implements Component {
	private readonly options: StartupHeaderOptions;
	private expanded: boolean;

	constructor(options: StartupHeaderOptions) {
		this.options = options;
		this.expanded = options.expanded ?? false;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {
		// Styling is resolved during render so theme changes apply immediately.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const contentWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		const addLine = (line: string) => {
			lines.push(truncateToWidth(` ${line}`, width, ""));
		};
		const addWrapped = (text: string) => {
			for (const line of wrapTextWithAnsi(text, contentWidth)) {
				addLine(line);
			}
		};

		if (!this.expanded && width >= 100) {
			for (const line of renderLogo(this.options.version).split("\n")) {
				addLine(line);
			}
		} else {
			const name = theme.bold(theme.fg("accent", APP_NAME.toUpperCase()));
			const version = theme.fg("dim", ` v${this.options.version}`);
			const descriptor = theme.fg("muted", "  /  agent workspace");
			addLine(`${name}${version}${descriptor}`);
		}

		if (this.expanded) {
			lines.push("");
			for (const instruction of this.options.expandedInstructions.split("\n")) {
				addWrapped(instruction);
			}
			lines.push("");
			addWrapped(this.options.onboarding);
			return lines;
		}

		addWrapped(this.options.compactInstructions);
		addWrapped(this.options.expansionHint);
		if (width >= 100) {
			lines.push("");
			addWrapped(this.options.onboarding);
		}
		return lines;
	}
}
