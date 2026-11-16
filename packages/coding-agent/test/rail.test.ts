import { afterEach, describe, expect, it } from "vitest";
import { loadThemeJson } from "../src/core/theme/discovery.ts";
import { initTheme, setThemeInstance } from "../src/core/theme/runtime.ts";
import { createThemeFromJson } from "../src/core/theme/theme.ts";
import { railPrefix } from "../src/modes/interactive/components/rail.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

afterEach(() => {
	initTheme("dark");
});

describe("railPrefix", () => {
	it.each(["truecolor", "256color"] as const)("paints a blank cell in %s mode", (mode) => {
		setThemeInstance(createThemeFromJson(loadThemeJson("dark"), mode));
		const prefix = railPrefix("borderAccent");
		expect(prefix).toMatch(/^\x1b\[48;[\d;]+m \x1b\[49m $/);
		expect(stripAnsi(prefix)).toBe("  ");
	});

	it("keeps the glyph when the color is the terminal default", () => {
		const dark = loadThemeJson("dark");
		setThemeInstance(createThemeFromJson({ ...dark, colors: { ...dark.colors, borderAccent: "" } }, "truecolor"));
		expect(stripAnsi(railPrefix("borderAccent"))).toBe("│ ");
	});
});
