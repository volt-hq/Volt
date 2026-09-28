import { KeybindingsManager, setKeybindings } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.ts";
import {
	editorTopBorderLabel,
	editorTopBorderLabelForState,
	keyDisplayText,
} from "../src/modes/interactive/components/keybinding-hints.ts";

describe("editorTopBorderLabel", () => {
	beforeAll(() => {
		setKeybindings(new KeybindingsManager(KEYBINDINGS));
	});

	it("uses configured controls to explain steering while a turn is active", () => {
		const label = editorTopBorderLabel("steer");

		expect(label).toContain("STEER");
		expect(label).toContain(`${keyDisplayText("tui.input.submit")} now`);
		expect(label).toContain(`${keyDisplayText("app.message.followUp")} later`);
		expect(label).toContain(`${keyDisplayText("app.interrupt")} stop`);
	});

	it("shows steering controls only while streaming with editor text", () => {
		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: true,
				hasText: false,
				agentMode: "build",
				planReady: false,
			}),
		).toBe("ASK VOLT · BUILD");
		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: false,
				hasText: true,
				agentMode: "build",
				planReady: false,
			}),
		).toBe("ASK VOLT · BUILD");
		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: true,
				hasText: true,
				agentMode: "build",
				planReady: false,
			}),
		).toContain("STEER");
		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: false,
				hasText: false,
				agentMode: "plan",
				planReady: false,
			}),
		).toBe("PLAN · AGENT READ-ONLY");
	});

	it("asks for a ready-plan decision with configured keys once the run settles", () => {
		setKeybindings(new KeybindingsManager(KEYBINDINGS, { "app.plan.togglePane": "alt+x" }));
		try {
			for (const agentMode of ["plan", "build"] as const) {
				const label = editorTopBorderLabelForState({
					bashMode: false,
					streaming: false,
					hasText: true,
					agentMode,
					planReady: true,
				});
				expect(label).toBe(
					`PLAN READY · ${keyDisplayText("app.plan.togglePane")} choose next step · ${keyDisplayText("tui.input.submit")} send feedback`,
				);
				expect(label).toMatch(/(Alt|Option)\+X choose next step/);
			}
		} finally {
			setKeybindings(new KeybindingsManager(KEYBINDINGS));
		}

		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: true,
				hasText: false,
				agentMode: "plan",
				planReady: true,
			}),
		).toBe("PLAN · AGENT READ-ONLY");
		expect(
			editorTopBorderLabelForState({
				bashMode: true,
				streaming: false,
				hasText: true,
				agentMode: "plan",
				planReady: true,
			}),
		).toBe("SHELL");
	});

	it("keeps idle and shell labels concise", () => {
		expect(editorTopBorderLabel("ask")).toBe("ASK VOLT");
		expect(
			editorTopBorderLabelForState({
				bashMode: true,
				streaming: true,
				hasText: true,
				agentMode: "plan",
				planReady: false,
			}),
		).toBe("SHELL");
	});
});
