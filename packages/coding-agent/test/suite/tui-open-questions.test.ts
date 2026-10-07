/**
 * What the host opening the TUI's conversation asks before it is open (its
 * project trust prompt, a `project_trust` hook's dialog; P7-8b) shows in the
 * running TUI, even while a move holds rendering, and where the user may be
 * typing: keys typed as a choice appears do not answer it. A confirmation
 * lists "No" first, letters do not move the selection, and nothing but
 * cancelling counts for its first moment.
 */

import type { HostPromptRequest, HostResponse } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_QUESTION_TYPING_GUARD_MS } from "../../src/modes/interactive/interactive-mode.ts";
import { createTuiHarness, type TuiHarness, type TuiModeFixture, waitForScreen } from "./tui-harness.ts";

const SETTINGS = { theme: "dark", quietStartup: true, lsp: { enabled: false }, compaction: { enabled: false } };
const ENTER = "\r";
const DOWN = "\x1b[B";

/** Wait out the typing guard of the question `title` once it shows. */
async function shown(tui: TuiModeFixture, title: string): Promise<void> {
	await waitForScreen(tui, title);
	await new Promise((resolve) => setTimeout(resolve, OPEN_QUESTION_TYPING_GUARD_MS + 100));
}

describe("questions the host asks as it opens the TUI's conversation", () => {
	const harnesses: TuiHarness[] = [];

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanup();
		vi.restoreAllMocks();
	});

	it("shows them before the conversation, and keys typed as one appears do not answer it", async () => {
		const harness = await createTuiHarness({ globalSettings: SETTINGS });
		harnesses.push(harness);
		const questions: HostPromptRequest[] = [
			{ kind: "confirm", title: "Trust this project?", message: "/work/project" },
			{ kind: "confirm", title: "Really trust it?", message: "/work/project" },
			{ kind: "select", title: "Trust project folder?", options: ["Do not trust (this session only)", "Trust"] },
		];
		const answers: Array<HostResponse | undefined> = [];
		const open = harness.connector.open.bind(harness.connector);
		vi.spyOn(harness.connector, "open").mockImplementation(async (target, options) => {
			const ask = options?.askHostRequest;
			if (target.kind === "startup" && ask !== undefined) {
				for (const question of questions) answers.push(await ask(question, new AbortController().signal));
			}
			return open(target, options);
		});
		const tui = await harness.startMode({ columns: 100, rows: 30, connect: false });
		const connecting = tui.connect();

		// Typed as the confirmation appears: nothing answers it, and `j` never moves to "Yes".
		await waitForScreen(tui, "Trust this project?");
		const screen = tui.screen();
		expect(screen.indexOf("No")).toBeLessThan(screen.indexOf("Yes"));
		tui.terminal.sendInput("j");
		tui.terminal.sendInput(ENTER);
		await new Promise((resolve) => setTimeout(resolve, OPEN_QUESTION_TYPING_GUARD_MS + 100));
		expect(answers).toEqual([]);
		tui.terminal.sendInput("j");
		tui.terminal.sendInput(ENTER);
		await shown(tui, "Really trust it?");
		tui.terminal.sendInput(DOWN);
		tui.terminal.sendInput(ENTER);
		await shown(tui, "Trust project folder?");
		tui.terminal.sendInput(ENTER);
		await connecting;
		expect(answers).toEqual([
			{ confirmed: false },
			{ confirmed: true },
			{ value: "Do not trust (this session only)" },
		]);
	}, 30_000);

	it("shows a question asked while the TUI moves to another conversation", async () => {
		const harness = await createTuiHarness({ globalSettings: SETTINGS });
		harnesses.push(harness);
		const tui = await harness.startMode({ columns: 100, rows: 30 });
		const answers: Array<HostResponse | undefined> = [];
		const open = harness.connector.open.bind(harness.connector);
		vi.spyOn(harness.connector, "open").mockImplementation(async (target, options) => {
			const ask = options?.askHostRequest;
			if (target.kind === "session" && ask !== undefined) {
				const question: HostPromptRequest = {
					kind: "select",
					title: "Trust project folder?",
					options: ["Do not trust (this session only)", "Trust"],
				};
				answers.push(await ask(question, new AbortController().signal));
			}
			return open(target, options);
		});

		const moving = tui.submit("/clear");
		// The move holds rendering until its conversation shows; the question shows meanwhile.
		await shown(tui, "Trust project folder?");
		tui.terminal.sendInput(DOWN);
		tui.terminal.sendInput(ENTER);
		await moving;
		await vi.waitFor(() => expect(tui.store.moving).toBeUndefined());
		expect(answers).toEqual([{ value: "Trust" }]);
	}, 30_000);
});
