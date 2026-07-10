import { visibleWidth } from "@earendil-works/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { StartupHeaderComponent } from "../src/modes/interactive/components/logo.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createHeader(): StartupHeaderComponent {
	return new StartupHeaderComponent({
		version: "1.2.3",
		compactInstructions: "esc interrupt · / commands · ! shell · ctrl+o more",
		expandedInstructions: "escape to interrupt\nctrl+c to clear\n/ for commands",
		expansionHint: "Press ctrl+o to show full startup help and loaded resources.",
		onboarding: "Ask Volt to inspect, build, explain, or ship.",
	});
}

describe("StartupHeaderComponent", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("uses a compact lockup on narrow terminals", () => {
		const lines = createHeader().render(80);

		expect(stripAnsi(lines[0]!)).toContain("VOLT v1.2.3");
		expect(lines.length).toBeLessThan(7);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
	});

	it("uses the full wordmark when space permits", () => {
		const lines = createHeader().render(120);

		expect(lines.length).toBeGreaterThan(7);
		expect(lines.some((line) => stripAnsi(line).includes("______"))).toBe(true);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}
	});

	it("uses the compact lockup when terminal height is constrained", () => {
		const header = new StartupHeaderComponent({
			version: "1.2.3",
			compactInstructions: "esc interrupt · / commands",
			expandedInstructions: "escape to interrupt",
			expansionHint: "Press ctrl+o for more.",
			onboarding: "Ask Volt to inspect, build, explain, or ship.",
			getTerminalRows: () => 24,
		});
		const lines = header.render(120).map(stripAnsi);

		expect(lines[0]).toContain("VOLT v1.2.3");
		expect(lines.some((line) => line.includes("______"))).toBe(false);
	});

	it("prioritizes command details when expanded", () => {
		const header = createHeader();
		header.setExpanded(true);
		const lines = header.render(80).map(stripAnsi);

		expect(lines.join("\n")).toContain("ctrl+c to clear");
		expect(lines.join("\n")).toContain("Ask Volt to inspect");
		expect(lines.some((line) => line.includes("______"))).toBe(false);
	});
});
