import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { resetCapabilitiesCache, setCapabilities } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openBrowser } from "../../../src/utils/open-browser.ts";
import { createTuiHarness, type TuiHarness, type TuiModeFixture, waitForScreen } from "../tui-harness.ts";

vi.mock("../../../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

/** Press and release the primary button on the first visible cell of `label`. */
function click(tui: TuiModeFixture, label: string): void {
	const rows = tui.screen().split("\n");
	const row = rows.findIndex((line) => line.includes(label));
	if (row === -1) throw new Error(`The screen does not show ${label}`);
	const column = rows[row]!.indexOf(label);
	tui.terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}M`);
	tui.terminal.sendInput(`\x1b[<0;${column + 1};${row + 1}m`);
}

describe("#697 fullscreen link clicks", () => {
	let harness: TuiHarness;

	beforeEach(async () => {
		vi.mocked(openBrowser).mockReset();
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		harness = await createTuiHarness();
	});

	afterEach(async () => {
		await harness.cleanup();
		resetCapabilitiesCache();
	});

	it("opens only the http and https links model output renders", async () => {
		harness.faux.setResponses([
			fauxAssistantMessage(
				[
					"[LinkSecure](HTTPS://Example.com/docs)",
					"[LinkPlain](http://example.com/plain)",
					"[LinkDisk](file:///etc/passwd)",
					"[LinkShare](smb://attacker.invalid/share)",
					"[LinkApp](vscode://command/run)",
				].join("\n\n"),
			),
		]);
		const tui = await harness.startMode({ tuiMode: "fullscreen", columns: 100, rows: 40 });
		await tui.submit("Show the links");
		await waitForScreen(tui, "LinkSecure", "LinkPlain", "LinkDisk", "LinkShare", "LinkApp");

		for (const label of ["LinkDisk", "LinkShare", "LinkApp"]) {
			click(tui, label);
			await waitForScreen(tui, "Link not opened: only http and https links open");
		}
		expect(openBrowser).not.toHaveBeenCalled();

		click(tui, "LinkSecure");
		click(tui, "LinkPlain");
		await tui.terminal.waitForRender();
		expect(vi.mocked(openBrowser).mock.calls).toEqual([["https://example.com/docs"], ["http://example.com/plain"]]);
	});
});
