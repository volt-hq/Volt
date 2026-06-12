import { APP_NAME } from "../../../config.ts";
import { theme } from "../theme/theme.ts";

const VOLT_WORDMARK = [
	"__   __ ___  _   _____ ",
	"\\ \\ / // _ \\| | |_   _|",
	" \\ V /| (_) | |__ | |  ",
	"  \\_/  \\___/|____||_|  ",
];

/**
 * Render the startup logo: an ASCII wordmark for "volt" with the version
 * appended, or a plain text logo when the app was renamed via voltConfig.name.
 */
export function renderLogo(version: string): string {
	if (APP_NAME !== "volt") {
		return theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${version}`);
	}
	const lines = VOLT_WORDMARK.map((line) => theme.bold(theme.fg("accent", line)));
	lines[lines.length - 1] += theme.fg("dim", ` v${version}`);
	return lines.join("\n");
}
