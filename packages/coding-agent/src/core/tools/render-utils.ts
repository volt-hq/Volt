/**
 * Format a duration for display, truncated: tenths of a second under a minute
 * ("3.2s"), then its two largest units ("3m 12s", "1h 4m", "2d 3h"), the
 * second dropped when zero ("30m"). `wholeSeconds` drops the tenths ("42s"),
 * for displays that update once a second or less often.
 */
export function formatDuration(ms: number, options: { wholeSeconds?: boolean } = {}): string {
	const tenths = Math.floor(Math.max(0, ms) / 100);
	const seconds = Math.floor(tenths / 10);
	if (seconds < 60) return options.wholeSeconds ? `${seconds}s` : `${seconds}.${tenths % 10}s`;
	const units = (major: number, majorUnit: string, minor: number, minorUnit: string): string =>
		minor === 0 ? `${major}${majorUnit}` : `${major}${majorUnit} ${minor}${minorUnit}`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return units(minutes, "m", seconds % 60, "s");
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return units(hours, "h", minutes % 60, "m");
	return units(Math.floor(hours / 24), "d", hours % 24, "h");
}
