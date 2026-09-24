import { AsyncLocalStorage } from "node:async_hooks";
import type { SkillFileIdentity } from "../skills.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

/** Internal producer data, never added to ordinary tool results or public exports. */
export type RepositoryObservation =
	| {
			kind: "read";
			path: string;
			text: string;
			startLine: number;
			endLine: number;
			revision: string;
			truncated: boolean;
	  }
	| { kind: "find"; paths: string[]; truncated: boolean }
	| { kind: "grep"; matches: Array<{ path: string; line: number; text: string }>; truncated: boolean };

/** Machine-readable producer failures, kept private to managed execution. */
export class RepositoryObservationError extends Error {
	readonly status: "unsupported" | "unavailable" | "invalidated";
	readonly reason: "non_text_input" | "backend_unavailable" | "resource_changed";

	constructor(
		status: "unsupported" | "unavailable" | "invalidated",
		reason: "non_text_input" | "backend_unavailable" | "resource_changed",
		message: string,
	) {
		super(message);
		this.status = status;
		this.reason = reason;
	}
}

interface RepositoryObservationContext {
	expectedRead?: Readonly<SkillFileIdentity>;
	capture(observation: RepositoryObservation): void;
}

const observationStorage = new AsyncLocalStorage<RepositoryObservationContext>();

/** Capture the context before installing producer callbacks (which may run in another async lineage). */
export function getRepositoryObservationContext(): RepositoryObservationContext | undefined {
	return observationStorage.getStore();
}

function lineCount(text: string): number {
	if (!text) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

function boundedObservation(observation: RepositoryObservation): RepositoryObservation | undefined {
	if (observation.kind === "read") {
		const bounded = { ...observation };
		if (
			lineCount(bounded.text) <= DEFAULT_MAX_LINES &&
			Buffer.byteLength(JSON.stringify(bounded)) <= DEFAULT_MAX_BYTES
		) {
			return bounded;
		}

		// Keep complete raw lines, not a JSON or UTF-8 prefix. Account for escaping and metadata too.
		const lines = bounded.text.split("\n");
		if (bounded.text.endsWith("\n")) lines.pop();
		bounded.text = "";
		bounded.endLine = bounded.startLine - 1;
		bounded.truncated = true;
		if (Buffer.byteLength(JSON.stringify(bounded)) > DEFAULT_MAX_BYTES) return undefined;
		let low = 0;
		let high = Math.min(lines.length, DEFAULT_MAX_LINES);
		while (low < high) {
			const count = Math.ceil((low + high) / 2);
			const candidate = {
				...bounded,
				text: lines.slice(0, count).join("\n"),
				endLine: bounded.startLine + count - 1,
			};
			if (Buffer.byteLength(JSON.stringify(candidate)) <= DEFAULT_MAX_BYTES) low = count;
			else high = count - 1;
		}
		bounded.text = lines.slice(0, low).join("\n");
		bounded.endLine = bounded.startLine + low - 1;
		return bounded;
	}

	const bounded: RepositoryObservation =
		observation.kind === "find"
			? { kind: "find", paths: [], truncated: true }
			: { kind: "grep", matches: [], truncated: true };
	// false is one byte longer than true; reserve enough for either final coverage flag.
	let bytes = Buffer.byteLength(JSON.stringify({ ...bounded, truncated: false }));
	let lines = 0;
	const entries = observation.kind === "find" ? observation.paths : observation.matches;
	let count = 0;
	for (const entry of entries) {
		const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + (count > 0 ? 1 : 0);
		const entryLines =
			typeof entry === "string"
				? entry.split("\n").length
				: entry.path.split("\n").length + entry.text.split("\n").length - 1;
		if (bytes + entryBytes > DEFAULT_MAX_BYTES || lines + entryLines > DEFAULT_MAX_LINES) break;
		bytes += entryBytes;
		lines += entryLines;
		count++;
	}
	if (bounded.kind === "find" && observation.kind === "find") bounded.paths = observation.paths.slice(0, count);
	if (bounded.kind === "grep" && observation.kind === "grep") {
		bounded.matches = observation.matches.slice(0, count).map((match) => ({ ...match }));
	}
	bounded.truncated = observation.truncated || count < entries.length;
	return bounded;
}

/** Run the same live native tool in a private, isolated observation scope. */
export async function withRepositoryObservation<T>(
	run: () => Promise<T>,
	expectedRead?: Readonly<SkillFileIdentity>,
): Promise<{ result: T; observation?: RepositoryObservation }> {
	let active = true;
	let observation: RepositoryObservation | undefined;
	return observationStorage.run(
		{
			expectedRead,
			capture(value) {
				if (active) observation = boundedObservation(value);
			},
		},
		async () => {
			try {
				const result = await run();
				return { result, ...(observation === undefined ? {} : { observation }) };
			} finally {
				active = false;
			}
		},
	);
}
