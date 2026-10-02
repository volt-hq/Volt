/**
 * Generic TypeBox helpers for the RPC contract schemas.
 *
 * Contract schemas serve three masters at once: `Static` types re-exported
 * from `types.ts`, compiled runtime validation, and the JSON Schema artifact
 * consumed by clients. Helpers here keep those three views in lockstep.
 */

import { type Static, type TSchema, type TUnsafe, Type } from "typebox";

/** Options bag accepted by every helper; extra `x-volt-*` keys flow into the artifact. */
export type WireSchemaOptions = Record<string, unknown>;

/**
 * Closed string enum emitted as JSON Schema `enum` (friendlier to non-TypeBox
 * consumers than anyOf-of-const).
 */
export function stringEnum<const T extends readonly string[]>(
	values: T,
	options?: WireSchemaOptions,
): TUnsafe<T[number]> {
	return Type.Unsafe<T[number]>({ ...options, type: "string", enum: [...values] });
}

/**
 * Open string union: the known values are documentation, not a constraint.
 * Mirrors the hand-written `KnownLiteral | (string & {})` pattern — novel
 * values MUST validate, so this never emits `enum`.
 */
export function openStringEnum<const T extends readonly string[]>(
	values: T,
	options?: WireSchemaOptions,
): TUnsafe<T[number] | (string & {})> {
	return Type.Unsafe<T[number] | (string & {})>({ ...options, type: "string", "x-volt-known-values": [...values] });
}

/**
 * A deliberately unschematized wire position. Accepts anything; the note lands
 * in the artifact as `x-volt-opaque` so clients know the omission is a choice.
 */
export function opaque<T>(note: string): TUnsafe<T> {
	return Type.Unsafe<T>(Type.Unknown({ "x-volt-opaque": note }));
}

/** Array schema whose static type preserves the hand-written `readonly` modifier. */
export function readonlyArrayOf<S extends TSchema>(
	items: S,
	options?: WireSchemaOptions,
): TUnsafe<readonly Static<S>[]> {
	return Type.Unsafe<readonly Static<S>[]>(Type.Array(items, options));
}

/**
 * Mutual-assignability check used to pin `Static` schema types to their
 * hand-written or upstream counterparts. Catches missing/extra/optionality/
 * readonly drift; deliberately tolerant of intersection-vs-flattened shape
 * (which strict `Equals` tricks false-negative on). Resolves to `false` (never
 * `never`) on mismatch so `Assert` reliably rejects it.
 */
export type MutualExtends<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * The JSON wire shape of a TS type: properties that admit `undefined` become
 * optional, because JSON.stringify drops them from the serialized object.
 * `unknown`-typed properties stay required (undefined extends unknown, but the
 * property models an always-present opaque value). Shallow by design — apply
 * per level where upstream types use `| undefined`.
 */
export type JsonWireShape<T> = {
	[K in keyof T as unknown extends T[K] ? never : undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} & {
	[K in keyof T as unknown extends T[K] ? K : undefined extends T[K] ? never : K]: T[K];
};

/** Anchors a `MutualExtends` assertion in a type alias; `false`/`never` fail the constraint visibly. */
export type Assert<T extends true> = T;
