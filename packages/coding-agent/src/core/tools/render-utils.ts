/** Format a tool execution duration for display, e.g. "3.2s". */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}
