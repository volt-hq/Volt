/**
 * The daemon's shared theme (§9.5, M11): its resolved theme tokens reach
 * devices in the `host_status` query's `theme`, refetched on `changed{host}`.
 * Off by default (voltd settings.themeTokenPush or VOLT_HOST_THEME_TOKENS=1).
 */

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
