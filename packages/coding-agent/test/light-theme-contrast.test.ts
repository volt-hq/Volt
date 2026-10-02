import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

interface ThemeJson {
	vars: Record<string, string>;
	colors: Record<string, string>;
}

function loadLightTheme(): ThemeJson {
	return JSON.parse(readFileSync(new URL("../src/core/theme/light.json", import.meta.url), "utf8")) as ThemeJson;
}

function resolveColor(theme: ThemeJson, token: string): string {
	let value = theme.colors[token] ?? token;
	const visited = new Set<string>();
	while (!value.startsWith("#")) {
		if (!visited.add(value)) throw new Error(`Cyclic light-theme color alias: ${value}`);
		value = theme.vars[value] ?? value;
		if (!value.startsWith("#") && theme.vars[value] === undefined) {
			throw new Error(`Unresolved light-theme color: ${value}`);
		}
	}
	return value;
}

function relativeLuminance(hex: string): number {
	const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
	const linear = channels.map((channel) =>
		channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrastRatio(foreground: string, background: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

function expectContrast(theme: ThemeJson, foreground: string, background: string, minimum = 4.5): void {
	const actual = contrastRatio(resolveColor(theme, foreground), resolveColor(theme, background));
	expect(actual, `${foreground} on ${background}`).toBeGreaterThanOrEqual(minimum);
}

describe("built-in light theme contrast", () => {
	test("keeps semantic foregrounds readable on a light terminal", () => {
		const theme = loadLightTheme();
		for (const token of [
			"accent",
			"border",
			"borderAccent",
			"borderMuted",
			"success",
			"error",
			"warning",
			"muted",
			"dim",
			"text",
			"thinkingText",
			"customMessageLabel",
			"toolTitle",
			"toolOutput",
			"mdHeading",
			"mdLink",
			"mdLinkUrl",
			"mdCode",
			"mdCodeBlock",
			"mdQuote",
			"toolDiffAdded",
			"toolDiffRemoved",
			"toolDiffContext",
			"thinkingOff",
			"thinkingMinimal",
			"thinkingLow",
			"thinkingMedium",
			"thinkingHigh",
			"thinkingXhigh",
			"bashMode",
		]) {
			expectContrast(theme, token, "#ffffff");
		}
	});

	test("keeps text readable on selected and message surfaces", () => {
		const theme = loadLightTheme();
		for (const token of ["accent", "success", "error", "warning", "muted", "dim", "text"]) {
			expectContrast(theme, token, "selectedBg");
		}
		expectContrast(theme, "userMessageText", "userMessageBg");
		expectContrast(theme, "customMessageText", "customMessageBg");
		expectContrast(theme, "customMessageLabel", "customMessageBg");
		for (const surface of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"]) {
			expectContrast(theme, "toolTitle", surface);
			expectContrast(theme, "toolOutput", surface);
		}
	});
});
