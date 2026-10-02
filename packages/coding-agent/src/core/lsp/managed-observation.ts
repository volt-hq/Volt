import { AsyncLocalStorage } from "node:async_hooks";
import type { LspRange } from "./client.ts";
import type { LspOutcome } from "./outcome.ts";

export interface ManagedLspLocation {
	path: string;
	startLine: number;
	startColumn: number;
	endLine: number;
	endColumn: number;
}

export interface ManagedLspSymbol extends ManagedLspLocation {
	name: string;
	kind: number;
}

export type ManagedLspObservation =
	| { kind: "symbols"; symbols: ManagedLspSymbol[]; truncated: boolean; coverage: "unknown" }
	| { kind: "locations"; locations: ManagedLspLocation[]; truncated: boolean; coverage: "unknown" };

interface ObservationContext {
	observation?: ManagedLspObservation;
	outcome?: LspOutcome;
}

const context = new AsyncLocalStorage<ObservationContext>();
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

type ResolveLocation = (uri: string) => Promise<{ path: string } | { error: string }>;

/** Private, operation-local discovery. Never attached to foreground tool results. */
export async function withManagedLspObservation<T>(
	run: () => Promise<T>,
): Promise<{ result: T; observation?: ManagedLspObservation; outcome?: LspOutcome }> {
	const captured: ObservationContext = {};
	const result = await context.run(captured, run);
	return { result, observation: captured.observation, outcome: captured.outcome };
}

export function isManagedLspObservation(): boolean {
	return context.getStore() !== undefined;
}

/** Only the native tool records the terminal outcome; no error prose crosses this boundary. */
export function recordManagedLspOutcome(outcome: LspOutcome): void {
	const captured = context.getStore();
	if (!captured) return;
	captured.outcome = outcome;
	if (outcome !== "success" && outcome !== "empty") delete captured.observation;
}

function location(path: string, range: LspRange | undefined): ManagedLspLocation | undefined {
	if (
		!range ||
		![range.start, range.end].every(
			(position) =>
				position &&
				Number.isSafeInteger(position.line) &&
				position.line >= 0 &&
				position.line < Number.MAX_SAFE_INTEGER &&
				Number.isSafeInteger(position.character) &&
				position.character >= 0 &&
				position.character < Number.MAX_SAFE_INTEGER,
		) ||
		range.end.line < range.start.line ||
		(range.end.line === range.start.line && range.end.character < range.start.character)
	)
		return undefined;
	return {
		path,
		startLine: range.start.line + 1,
		startColumn: range.start.character + 1,
		endLine: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

function fits(observation: ManagedLspObservation): boolean {
	// Pretty JSON is the conservative bound (also bounds compact serialization).
	const json = JSON.stringify(observation, null, 2);
	return Buffer.byteLength(json, "utf8") <= MAX_BYTES && json.split("\n").length <= MAX_LINES;
}

export async function recordManagedLspLocations(
	locations: readonly { uri: string; range: LspRange }[],
	resolveLocation: ResolveLocation,
	limit: number,
): Promise<void> {
	const captured = context.getStore();
	if (!captured) return;
	const observation: ManagedLspObservation = {
		kind: "locations",
		locations: [],
		truncated: locations.length > limit,
		coverage: "unknown",
	};
	for (const item of locations.slice(0, limit)) {
		const canonical = await resolveLocation(item.uri);
		const value = "path" in canonical ? location(canonical.path, item.range) : undefined;
		if (!value) {
			observation.truncated = true;
			continue;
		}
		observation.locations.push(value);
		if (!fits(observation)) {
			observation.locations.pop();
			observation.truncated = true;
			break;
		}
	}
	captured.observation = observation;
}

interface DiscoverySymbol {
	name: string;
	kind: number;
	range?: LspRange;
	selectionRange?: LspRange;
	location?: { uri?: string; range?: LspRange };
	children?: DiscoverySymbol[];
}

export async function recordManagedLspSymbols(
	symbols: readonly DiscoverySymbol[],
	documentPath: string | undefined,
	resolveLocation: ResolveLocation,
	limit: number,
): Promise<void> {
	const captured = context.getStore();
	if (!captured) return;
	const observation: ManagedLspObservation = {
		kind: "symbols",
		symbols: [],
		truncated: false,
		coverage: "unknown",
	};
	// Iterator stack avoids recursive traversal or allocating an unbounded flattened index.
	const stack = [symbols[Symbol.iterator]()];
	let visited = 0;
	while (stack.length) {
		const next = stack[stack.length - 1].next();
		if (next.done) {
			stack.pop();
			continue;
		}
		if (visited++ === limit) {
			observation.truncated = true;
			break;
		}
		const symbol = next.value;
		const canonical = symbol.location?.uri ? await resolveLocation(symbol.location.uri) : undefined;
		const path = canonical ? ("path" in canonical ? canonical.path : undefined) : documentPath;
		const range = symbol.location?.range ?? symbol.selectionRange ?? symbol.range;
		const value = path ? location(path, range) : undefined;
		if (!value || typeof symbol.name !== "string" || !Number.isInteger(symbol.kind)) {
			observation.truncated = true;
		} else {
			observation.symbols.push({ ...value, name: symbol.name, kind: symbol.kind });
			if (!fits(observation)) {
				observation.symbols.pop();
				observation.truncated = true;
				break;
			}
		}
		if (Array.isArray(symbol.children)) stack.push(symbol.children[Symbol.iterator]());
	}
	captured.observation = observation;
}
