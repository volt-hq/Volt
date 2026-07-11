import { KeybindingsManager, setKeybindings } from "@earendil-works/volt-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.ts";
import { editorTopBorderLabel, keyDisplayText } from "../src/modes/interactive/components/keybinding-hints.ts";

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

	it("keeps idle and shell labels concise", () => {
		expect(editorTopBorderLabel("ask")).toBe("ASK VOLT");
		expect(editorTopBorderLabel("shell")).toBe("SHELL");
	});
});
