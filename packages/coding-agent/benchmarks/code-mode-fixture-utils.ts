/** Synthetic routing tasks, not a measure of general reasoning or troubleshooting quality. */
export interface BenchmarkFixture {
	id: string;
	prompt: string;
	tools: Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
		outputSchema?: Record<string, unknown>;
		annotations: {
			readOnlyHint: true;
			destructiveHint: false;
			idempotentHint: true;
			openWorldHint: false;
		};
	}>;
	call(name: string, args: Record<string, unknown>): Record<string, unknown>;
	expected: Record<string, unknown>;
	grade(answer: string): { correct: boolean; reason?: string };
	referenceCode: string;
}

type Handler = (args: Record<string, unknown>) => Record<string, unknown>;

export function objectSchema(properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> {
	return { type: "object", properties, required, additionalProperties: false };
}

export function tool(
	name: string,
	description: string,
	inputSchema: Record<string, unknown>,
	outputSchema: Record<string, unknown>,
): BenchmarkFixture["tools"][number] {
	return {
		name,
		description,
		inputSchema,
		outputSchema,
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	};
}

export function validateArguments(args: Record<string, unknown>, allowed: string[]): void {
	if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Arguments must be an object");
	for (const key of Object.keys(args)) {
		if (!allowed.includes(key)) throw new Error(`Unknown argument: ${key}`);
	}
}

export function lookup<T extends { id: string }>(rows: T[], args: Record<string, unknown>): T {
	validateArguments(args, ["id"]);
	if (typeof args.id !== "string" || args.id.length === 0) throw new Error("id must be a nonempty string");
	const row = rows.find((entry) => entry.id === args.id);
	if (!row) throw new Error(`Unknown id: ${args.id}`);
	return row;
}

export function page<T>(rows: T[], args: Record<string, unknown>): Record<string, unknown> {
	validateArguments(args, ["offset", "limit"]);
	const offset = Object.hasOwn(args, "offset") ? args.offset : 0;
	const limit = Object.hasOwn(args, "limit") ? args.limit : 20;
	if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > rows.length) {
		throw new Error(`offset must be an integer from 0 through ${rows.length}`);
	}
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 20) {
		throw new Error("limit must be an integer from 1 through 20");
	}
	const end = Math.min(offset + limit, rows.length);
	return { records: rows.slice(offset, end), nextOffset: end < rows.length ? end : null };
}

function exactJson(actual: unknown, expected: unknown): boolean {
	if (actual === expected) return true;
	if (Array.isArray(expected)) {
		return (
			Array.isArray(actual) &&
			actual.length === expected.length &&
			expected.every((value, index) => exactJson(actual[index], value))
		);
	}
	if (expected === null || typeof expected !== "object" || actual === null || typeof actual !== "object") return false;
	if (Array.isArray(actual)) return false;
	const actualObject = actual as Record<string, unknown>;
	const expectedObject = expected as Record<string, unknown>;
	const keys = Object.keys(expectedObject);
	return (
		Object.keys(actualObject).length === keys.length &&
		keys.every((key) => Object.hasOwn(actualObject, key) && exactJson(actualObject[key], expectedObject[key]))
	);
}

export function fixture(
	definition: Omit<BenchmarkFixture, "call" | "grade">,
	handlers: Record<string, Handler>,
): BenchmarkFixture {
	// The public expected value is useful to the runner, but cannot mutate the grading oracle.
	const expected = structuredClone(definition.expected);
	return {
		...definition,
		call(name, args) {
			if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown tool: ${name}`);
			return structuredClone(handlers[name](args));
		},
		grade(answer) {
			const trimmed = answer.trim();
			// A turn that ends without text is a different failure from a malformed answer; keep them apart.
			if (!trimmed) return { correct: false, reason: "The final reply was empty." };
			const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
			let parsed: unknown;
			try {
				parsed = JSON.parse(fenced ? fenced[1] : trimmed);
			} catch {
				return { correct: false, reason: "Answer must be JSON, optionally inside one JSON code fence." };
			}
			return exactJson(parsed, expected)
				? { correct: true }
				: { correct: false, reason: "Answer does not exactly match the required fields and values." };
		},
	};
}
