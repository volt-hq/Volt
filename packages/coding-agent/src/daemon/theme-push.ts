/**
 * iOS theme token push (§9.5, M11): the daemon can push its resolved theme
 * tokens to phones as a `host_theme_tokens` frame on conversation streams.
 * Ships OFF by default (voltd settings.themeTokenPush or VOLT_HOST_THEME_TOKENS=1)
 * and is additionally gated on the phone advertising the capability string;
 * clients that ignore the frame are fully supported.
 */

export const HOST_THEME_TOKENS_FEATURE = "host_theme_tokens.v1";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Keep only plain hex color values. Anything else — var refs that failed to
 * resolve, ansi escape fragments, and especially anything path-like — is
 * dropped so no host-local information can leak onto the wire.
 */
export function sanitizeHostThemeTokens(tokens: Record<string, string>): Record<string, string> {
	const sanitized: Record<string, string> = {};
	for (const [name, value] of Object.entries(tokens)) {
		if (typeof value === "string" && HEX_COLOR_PATTERN.test(value)) {
			sanitized[name] = value;
		}
	}
	return sanitized;
}

export interface HostThemeTokensFrame {
	type: "host_theme_tokens";
	data: {
		themeName: string;
		tokens: Record<string, string>;
	};
}

export function createHostThemeTokensFrame(themeName: string, tokens: Record<string, string>): HostThemeTokensFrame {
	return {
		type: "host_theme_tokens",
		data: { themeName, tokens: sanitizeHostThemeTokens(tokens) },
	};
}
