import type { StoreCatalog, StoreCatalogPackage } from "../src/store/catalog.ts";

export const TEST_STORE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const NEXT_TEST_STORE_COMMIT = "89abcdef0123456789abcdef0123456789abcdef";

/** The source of a catalog entry pinned to `commit` on github.com/volt-hq/Volt. */
export function testStoreSource(commit = TEST_STORE_COMMIT): string {
	return `git:https://github.com/volt-hq/Volt@${commit}`;
}

/** A valid catalog v2 entry for `id`, pinned to and reviewed at `commit`. */
export function testCatalogEntry(
	id: string,
	overrides: Partial<StoreCatalogPackage> = {},
	commit = TEST_STORE_COMMIT,
): StoreCatalogPackage {
	return {
		id,
		name: "RTK Output Compression",
		description: "Token optimized shell output",
		version: "0.2.0",
		source: testStoreSource(commit),
		repo: `https://github.com/volt-hq/Volt/tree/store/${id}`,
		permissions: ["exec"],
		review: { commit, reviewer: "hansjm10", date: "2026-10-05", notes: "Manifest only on top of the last pin." },
		author: "Volt",
		license: "MIT",
		categories: ["shell"],
		resources: ["extensions"],
		...overrides,
	};
}

export function testCatalog(...packages: StoreCatalogPackage[]): StoreCatalog {
	return { schemaVersion: 2, packages };
}
