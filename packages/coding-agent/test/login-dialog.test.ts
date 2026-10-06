/**
 * The sign-in dialog shows a provider's sign-in page and prompts: it opens
 * and links only an http or https address, as the URL parser writes it, so
 * no control sequence of the provider's reaches the terminal, and a secret
 * prompt shows bullets, never the text typed or submitted.
 */

import { type Component, setKeybindings, type TUI } from "@hansjm10/volt-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { LoginDialogComponent, signInUrl } from "../src/modes/interactive/components/login-dialog.ts";
import { SecretInput } from "../src/modes/interactive/components/secret-input.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));

function dialog(): LoginDialogComponent {
	return new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "acme", () => {}, "Acme");
}

function rendered(component: Component): string {
	return component.render(120).lines.join("\n");
}

describe("the sign-in dialog", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.mocked(openBrowser).mockReset();
	});

	it.each([
		["https://acme.test/authorize?x=1", "https://acme.test/authorize?x=1"],
		["http://localhost:1455/auth", "http://localhost:1455/auth"],
		["https://acme.test/\u001b]8;;https://evil.test\u0007x", "https://acme.test/%1B]8;;https://evil.test%07x"],
	])("opens and links an http or https address as the URL parser writes it: %s", (url, address) => {
		expect(signInUrl(url)).toBe(address);
		const component = dialog();
		component.showAuth(url, "Sign in\u001b[2J here");
		expect(openBrowser).toHaveBeenCalledExactlyOnceWith(address);
		const output = rendered(component);
		expect(output).not.toContain("\u0007x");
		expect(output).not.toContain("\u001b[2J");
		expect(stripAnsi(output)).toContain("Sign in here");
	});

	it.each(["file:///etc/passwd", "javascript:alert(1)", "ssh://acme.test", "not a url"])(
		"neither opens nor links %s",
		(url) => {
			expect(signInUrl(url)).toBeUndefined();
			const component = dialog();
			component.showAuth(url);
			component.showDeviceCode({ verificationUri: url, userCode: "AB\u001b[31mCD" });
			expect(openBrowser).not.toHaveBeenCalled();
			const output = stripAnsi(rendered(component));
			expect(output).toContain("The sign-in address is not an http or https URL.");
			expect(output).not.toContain(url);
			expect(output).toContain("Enter code: ABCD");
		},
	);

	it("shows without opening a page it is told not to open, and strips escapes from its title", () => {
		const component = new LoginDialogComponent(
			{ requestRender: vi.fn() } as unknown as TUI,
			"acme",
			() => {},
			"Acme\u001b]8;;https://evil.test\u0007",
		);
		component.showAuth("https://acme.test/authorize", undefined, { open: false });
		expect(openBrowser).not.toHaveBeenCalled();
		const output = rendered(component);
		expect(stripAnsi(output)).toContain("https://acme.test/authorize");
		expect(output).not.toContain("evil.test");
	});

	it("masks a secret prompt and never shows what was submitted", async () => {
		const component = dialog();
		const answer = component.showPrompt("API key", undefined, { secret: true });
		component.handleInput("sk-secret");
		expect(stripAnsi(rendered(component))).toContain("> •••••••••");
		expect(rendered(component)).not.toContain("sk-secret");
		component.handleInput("\r");
		await expect(answer).resolves.toBe("sk-secret");
		expect(stripAnsi(rendered(component))).toContain("> (hidden)");
		expect(rendered(component)).not.toContain("sk-secret");
	});

	it("masks a secret input of its own", () => {
		const input = new SecretInput();
		input.handleInput("\u001b[200~pasted-secret\u001b[201~");
		expect(input.getValue()).toBe("pasted-secret");
		const output = rendered(input);
		expect(stripAnsi(output)).toContain(`> ${"•".repeat("pasted-secret".length)}`);
		expect(output).not.toContain("pasted-secret");
	});
});
