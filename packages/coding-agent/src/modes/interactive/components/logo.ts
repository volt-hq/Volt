import {
	type Component,
	createRenderFrame,
	type RenderFrame,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@hansjm10/volt-tui";
import { APP_NAME } from "../../../config.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { bgAnsi, fgAnsi } from "../../../core/theme/tokens.ts";
import type { ThemeColorValue } from "../../../core/theme/types.ts";

/**
 * The startup lockup as a pixel map: the bolt from site/public/volt-mark.svg and the "VOLT"
 * wordmark. Each pair of rows becomes one terminal line of half blocks. "#" takes the theme
 * accent, "d" and "l" are the bolt's dark and light halves, and spaces stay transparent.
 */
const VOLT_LOCKUP_PIXELS = [
	"                  #####          #####        ###########        ####              ####################",
	"     d             ####          ####        #############       ####              ####################",
	"     dd            #####        #####       ###############      ####              ####################",
	"     dd            #####        #####      #################     ####              ####################",
	"     ddd            ####        ####      #####         #####    ####                      ####",
	"     dddd           #####      #####      ####           ####    ####                      ####",
	"     dddd           #####      #####      ####           ####    ####                      ####",
	"     ddddd           #####    #####       ####           ####    ####                      ####",
	"      ddddd          #####    #####       ####           ####    ####                      ####",
	"llllllddddd           ####    ####        ####           ####    ####                      ####",
	" lllll                #####  #####        ####           ####    ####                      ####",
	" lllll                #####  #####        ####           ####    ####                      ####",
	"  llll                 ####  ####         ####           ####    ####                      ####",
	"   lll                 ##########         ####           ####    ####                      ####",
	"   lll                 ##########         ####           ####    ####                      ####",
	"    ll                  ########          #####         #####    ####                      ####",
	"    lll                 ########           #################     ##############            ####",
	"     ll                  ######             ###############      ##############            ####",
	"      l                  ######              #############       ##############            ####",
	"                         ######               ###########        ##############            ####",
];

const BOLT_DARK = "#6d4dc4";
const BOLT_LIGHT = "#a685ff";
const RESET_COLORS = "\x1b[39m\x1b[49m";

function lockupPixelColor(pixel: string): ThemeColorValue {
	if (pixel === "d") return BOLT_DARK;
	if (pixel === "l") return BOLT_LIGHT;
	return theme.resolvedColors["accent"] ?? "";
}

/** Encode the lockup pixel map as half-block lines (▀ ▄ █), one terminal line per pair of pixel rows. */
function renderLockup(): string[] {
	const mode = theme.getColorMode();
	const fg = (pixel: string) => fgAnsi(lockupPixelColor(pixel), mode);
	const lines: string[] = [];
	for (let row = 0; row < VOLT_LOCKUP_PIXELS.length; row += 2) {
		const top = VOLT_LOCKUP_PIXELS[row] ?? "";
		const bottom = VOLT_LOCKUP_PIXELS[row + 1] ?? "";
		let line = "";
		let activeStyle = "";
		for (let x = 0; x < Math.max(top.length, bottom.length); x++) {
			const upper = top[x] ?? " ";
			const lower = bottom[x] ?? " ";
			let style = "";
			let glyph = " ";
			if (upper !== " " && (lower === " " || lower === upper)) {
				style = fg(upper);
				glyph = lower === upper ? "█" : "▀";
			} else if (upper === " " && lower !== " ") {
				style = fg(lower);
				glyph = "▄";
			} else if (upper !== " ") {
				style = fg(upper) + bgAnsi(lockupPixelColor(lower), mode);
				glyph = "▀";
			}
			if (style !== activeStyle) {
				line += activeStyle ? RESET_COLORS + style : style;
				activeStyle = style;
			}
			line += glyph;
		}
		lines.push(activeStyle ? line + RESET_COLORS : line);
	}
	return lines;
}

/**
 * Render the startup logo: the half-block bolt and "VOLT" wordmark with the
 * version appended, or a plain text logo when the app was renamed via voltConfig.name.
 */
export function renderLogo(version: string): string {
	if (APP_NAME !== "volt") {
		return theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${version}`);
	}
	const lines = renderLockup();
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
	getTerminalRows?: () => number;
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

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const contentWidth = Math.max(1, width - 2);
		const lines: string[] = [];
		const addLine = (line: string) => {
			lines.push(truncateToWidth(` ${line}`, width, ""));
		};
		const addWrapped = (text: string, balanceShortTail = false) => {
			let wrapped = wrapTextWithAnsi(text, contentWidth);
			if (
				balanceShortTail &&
				wrapped.length > 1 &&
				visibleWidth(wrapped[wrapped.length - 1]!) < 12 &&
				contentWidth > 40
			) {
				wrapped = wrapTextWithAnsi(text, contentWidth - 12);
			}
			for (const line of wrapped) {
				addLine(line);
			}
		};

		const terminalRows = this.options.getTerminalRows?.() ?? 30;
		if (!this.expanded && width >= 140 && terminalRows >= 36) {
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
			return createRenderFrame(lines);
		}

		addWrapped(this.options.compactInstructions, true);
		addWrapped(this.options.expansionHint);
		if (width >= 100) {
			lines.push("");
			addWrapped(this.options.onboarding);
		}
		return createRenderFrame(lines);
	}
}
