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
			}),
		).toBe("ASK VOLT · BUILD");
		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: false,
				hasText: true,
				agentMode: "build",
			}),
		).toBe("ASK VOLT · BUILD");
		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: true,
				hasText: true,
				agentMode: "build",
			}),
		).toContain("STEER");
		expect(
			editorTopBorderLabelForState({
				bashMode: false,
				streaming: false,
				hasText: false,
				agentMode: "plan",
			}),
		).toBe("PLAN · AGENT READ-ONLY");
	});

	it("keeps idle and shell labels concise", () => {
		expect(editorTopBorderLabel("ask")).toBe("ASK VOLT");
		expect(
			editorTopBorderLabelForState({
				bashMode: true,
				streaming: true,
				hasText: true,
				agentMode: "plan",
			}),
		).toBe("SHELL");
	});
});
