import { setKeybindings } from "@hansjm10/volt-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { isApiKeyLoginProvider } from "../src/core/provider-auth.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../src/core/provider-display-names.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("OAuthSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps built-in API key providers separate from OAuth-only providers", () => {
		const oauthProviderIds = new Set(["anthropic", "github-copilot", "custom-oauth"]);
		const builtInProviderIds = new Set(["anthropic", "github-copilot", "amazon-bedrock", "openai"]);

		expect(isApiKeyLoginProvider("anthropic", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES.anthropic).toBe("Anthropic");
		expect(isApiKeyLoginProvider("openai", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("github-copilot", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("amazon-bedrock", oauthProviderIds, builtInProviderIds)).toBe(true);
		expect(isApiKeyLoginProvider("custom-oauth", oauthProviderIds, builtInProviderIds)).toBe(false);
		expect(isApiKeyLoginProvider("custom-api", oauthProviderIds, builtInProviderIds)).toBe(true);
	});

	it("shows stored OAuth auth distinctly in the API key selector", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "anthropic", name: "Anthropic", authType: "api_key", stored: "oauth" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).lines.join("\n"));

		expect(output).toContain("Anthropic");
		expect(output).toContain("subscription configured");
	});

	it("shows environment API key auth as configured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "openai", name: "OpenAI", authType: "api_key", source: "environment", label: "OPENAI_API_KEY" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).lines.join("\n"));

		expect(output).toContain("OpenAI");
		expect(output).toContain("✓ env: OPENAI_API_KEY");
		expect(output).not.toContain("unconfigured");
	});

	it("shows stored credentials of the method being configured as configured", () => {
		const selector = new OAuthSelectorComponent(
			"logout",
			[{ id: "openai", name: "OpenAI", authType: "api_key", stored: "api_key", source: "stored" }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).lines.join("\n"));

		expect(output).toContain("OpenAI");
		expect(output).toContain("✓ configured");
	});

	it.each([
		["models_json_key", "✓ key in models.json"],
		["models_json_command", "✓ command in models.json"],
		["runtime", "✓ runtime API key"],
		["fallback", "✓ custom API key"],
	] as const)("shows %s API key auth as configured", (source, shown) => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "local-proxy", name: "local-proxy", authType: "api_key", source }],
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(120).lines.join("\n"));

		expect(output).toContain("local-proxy");
		expect(output).toContain(shown);
		expect(output).not.toContain("unconfigured");
	});

	it("shows a provider without credentials as unconfigured", () => {
		const selector = new OAuthSelectorComponent(
			"login",
			[{ id: "acme", name: "Acme", authType: "oauth" }],
			() => {},
			() => {},
		);

		expect(stripAnsi(selector.render(120).lines.join("\n"))).toContain("Acme • unconfigured");
	});
});
