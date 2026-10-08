import type { ReviewEngineContext } from "@hansjm10/volt-coding-agent";

/** Lines the host's file tool returns per call at most. */
const PAGE_LINES = 2_000;
/** Pages read for one file at most: a policy or a base file past this is cut. */
const MAX_PAGES = 25;
const CURSOR_MARKER = "\n\nNext cursor: ";

/**
 * Reads a file as it was before the change, from the host's snapshot of the reviewed change through its
 * `review_file` tool: the base revision may live only in the host's snapshot (a fetched merge base, a pull
 * request's base), not in the user's repository. The tool numbers its lines (`12: text`) and pages them; this
 * undoes both. Undefined when the file does not exist at the base or is not text.
 */
export function createBaseReader(
	engine: ReviewEngineContext,
): (path: string, signal: AbortSignal) => Promise<string | undefined> {
	const tool = engine
		.pass()
		.tools()
		.find((candidate) => candidate.name === "review_file");
	if (!tool) throw new Error("The host's review_file tool is not available");
	return async (path, signal) => {
		const lines: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			let text: string;
			try {
				const result = await tool.execute(
					"swarm-read-base",
					{ path, revision: "base", limit: PAGE_LINES, ...(cursor === undefined ? {} : { cursor }) } as never,
					signal,
					undefined,
					{} as never,
				);
				text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			} catch (error) {
				if (signal.aborted) throw error;
				return undefined;
			}
			const marker = text.indexOf(CURSOR_MARKER);
			const body = marker === -1 ? text : text.slice(0, marker);
			for (const line of body.split("\n")) lines.push(line.replace(/^\d+: ?/, ""));
			if (marker === -1) return lines.join("\n");
			cursor = text.slice(marker + CURSOR_MARKER.length).trim();
		}
		return lines.join("\n");
	};
}
