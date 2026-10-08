/** Strip `//` line comments and trailing commas from JSON, leaving string literals untouched. */
export function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** `T` with each property that may be `undefined` made optional and its `undefined` removed from the type. */
export type OmitUndefined<T> = {
	[K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
	[K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/**
 * A shallow copy of `value` without its `undefined` properties. Volt's JSON data contract has no
 * `undefined`, so a value that may be absent is omitted rather than stored as `undefined`.
 */
export function omitUndefined<T extends object>(value: T): OmitUndefined<T> {
	return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as OmitUndefined<T>;
}
