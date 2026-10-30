/**
 * The `/extensions` remote commands view: a switch per command the extension
 * does not mark remote-safe, on for the ones the user allows; the extension's
 * own remote-safe commands listed without a switch; saving replaces the
 * user's list with the commands switched on and reloads.
 */

import type { ExtensionRemoteCommand } from "@hansjm10/volt-protocol";
import { setKeybindings } from "@hansjm10/volt-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	ExtensionRemoteCommandsComponent,
	type ExtensionRemoteCommandsSource,
} from "../src/modes/interactive/components/extension-remote-commands.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const SPACE = " ";
const ENTER = "\r";
const DOWN = "\x1b[B";

function view(commands: ExtensionRemoteCommand[], save: ExtensionRemoteCommandsSource["save"] = async () => {}) {
	let stored = commands;
	const source: ExtensionRemoteCommandsSource = {
		load: vi.fn(async () => stored),
		save: vi.fn(async (allowed: readonly string[]) => {
			await save(allowed);
			stored = stored.map((command) =>
				command.access === "extension"
					? command
					: { ...command, access: allowed.includes(command.name) ? "user" : "local" },
			);
		}),
	};
	const onClose = vi.fn();
	const component = new ExtensionRemoteCommandsComponent({ id: "goal", displayName: "Goal" }, source, {
		onClose,
		requestRender: () => {},
	});
	component.focused = true;
	return { component, source, onClose, text: () => stripAnsi(component.render(100).lines.join("\n")) };
}

describe("the remote commands view", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("switches the commands the user decides, lists the extension's own, and saves the ones switched on", async () => {
		const { component, source, text } = view([
			{ name: "goal-pause", description: "Pause the goal", access: "user" },
			{ name: "goal-resume", access: "local" },
			{ name: "goal-status", access: "extension" },
		]);
		await component.start();
		expect(text()).toContain("Goal goal · remote commands");
		expect(text()).toContain("Always allowed by the extension: /goal-status");
		expect(text()).toContain("/goal-pause");
		expect(text()).toContain("/goal-resume");

		// Turn /goal-pause off and /goal-resume on.
		component.handleInput(SPACE);
		component.handleInput(DOWN);
		component.handleInput(SPACE);
		component.handleInput(ENTER);

		await vi.waitFor(() => expect(text()).toContain("Saved: 1 allowed"));
		expect(source.save).toHaveBeenCalledExactlyOnceWith(["goal-resume"]);
		expect(source.load).toHaveBeenCalledTimes(2);

		// The saved view keeps the field the user was on: /goal-resume turns off again.
		component.handleInput(SPACE);
		component.handleInput(ENTER);
		await vi.waitFor(() => expect(text()).toContain("Saved: no commands allowed"));
		expect(source.save).toHaveBeenLastCalledWith([]);
	});

	it("shows a save the host refused, and keeps the switches", async () => {
		const { component, text } = view([{ name: "goal-resume", access: "local" }], async () => {
			throw new Error("Host global settings could not be loaded; repair them and reload");
		});
		await component.start();
		component.handleInput(SPACE);
		component.handleInput(ENTER);
		await vi.waitFor(() => expect(text()).toContain("Host global settings could not be loaded"));
	});

	it.each([
		[[], "This extension registers no commands."],
		[[{ name: "status", access: "extension" } as const], "The extension allows every command it registers."],
	])("has nothing to switch for %j, and closes on any key", async (commands, message) => {
		const { component, onClose, text } = view([...commands]);
		await component.start();
		expect(text()).toContain(message);
		component.handleInput(ENTER);
		expect(onClose).toHaveBeenCalledOnce();
	});
});
