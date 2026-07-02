import { APP_NAME } from "../../../config.ts";
import { theme } from "../../../core/theme/runtime.ts";

const VOLT_WORDMARK = [
	"__          __   ______    _        _________ ",
	"\\ \\        / /  /  __  \\  | |      |___   ___|",
	" \\ \\      / /  |  /  \\  | | |          | |    ",
	"  \\ \\    / /   | |    | | | |          | |    ",
	"   \\ \\  / /    | |    | | | |          | |    ",
	"    \\ \\/ /     |  \\__/  | | |____      | |    ",
	"      \\/        \\______/  |______|     |_|   ",
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
