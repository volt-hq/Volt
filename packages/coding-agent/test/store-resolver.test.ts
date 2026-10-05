import { describe, expect, it } from "vitest";
import { resolveStoreSource } from "../src/store/resolver.ts";
import {
	NEXT_TEST_STORE_COMMIT,
	TEST_STORE_COMMIT,
	testCatalog,
	testCatalogEntry,
	testStoreSource,
} from "./store-catalog-fixtures.ts";

const catalog = testCatalog(testCatalogEntry("rtk"));

describe("store resolver", () => {
	it("maps catalog IDs to their reviewed pins and preserves catalog metadata", async () => {
		const resolved = await resolveStoreSource({
			input: "rtk",
			catalog,
			gitLsRemote: () => {
				throw new Error("a catalog pin needs no ls-remote");
			},
		});

		expect(resolved.kind).toBe("catalog");
		expect(resolved.source).toBe(testStoreSource());
		expect(resolved.catalogPackage?.id).toBe("rtk");
		expect(resolved.pinned).toBe(true);
		expect(resolved.tracking).toBe(false);
		expect(resolved.warnings).toEqual([]);
	});

	it.each([
		[{ ref: "main" }, "--ref does not apply to catalog package rtk"],
		[{ track: true }, "--track does not apply to catalog package rtk"],
	])("refuses to move a catalog package off its reviewed pin (%j)", async (options, message) => {
		await expect(resolveStoreSource({ input: "rtk", catalog, ...options })).rejects.toThrow(message);
	});

	it("refuses a catalog package whose host is not allowlisted or whose review is for another commit", async () => {
		const offHost = testCatalog(
			testCatalogEntry("rtk", { source: `git:https://example.com/volt-hq/Volt@${TEST_STORE_COMMIT}` }),
		);
		const unreviewed = testCatalog(testCatalogEntry("rtk", { source: testStoreSource(NEXT_TEST_STORE_COMMIT) }));

		await expect(resolveStoreSource({ input: "rtk", catalog: offHost })).rejects.toThrow(
			"Catalog package rtk is not installable: source host example.com is not allowed",
		);
		await expect(resolveStoreSource({ input: "rtk", catalog: unreviewed })).rejects.toThrow(
			`Catalog package rtk is not installable: review.commit ${TEST_STORE_COMMIT} is not the pinned commit`,
		);
	});

	it("rejects unknown bare IDs with suggestions", async () => {
		await expect(resolveStoreSource({ input: "rkt", catalog })).rejects.toThrow("Did you mean rtk?");
	});

	it("recognizes exact and unpinned npm specs", async () => {
		const exact = await resolveStoreSource({ input: "npm:@scope/pkg@1.2.3", catalog });
		const unpinned = await resolveStoreSource({ input: "npm:@scope/pkg", catalog });

		expect(exact.pinned).toBe(true);
		expect(exact.tracking).toBe(false);
		expect(unpinned.pinned).toBe(false);
		expect(unpinned.tracking).toBe(true);
		expect(unpinned.warnings).toContain("npm package @scope/pkg is not pinned to an exact version.");
	});

	it("marks non-exact npm specs as tracking", async () => {
		const ranged = await resolveStoreSource({ input: "npm:@scope/ranged-theme@^1.0.0", catalog });
		const latest = await resolveStoreSource({ input: "npm:@scope/latest-theme@latest", catalog });

		expect(ranged.pinned).toBe(false);
		expect(ranged.tracking).toBe(true);
		expect(ranged.warnings).toContain('npm package @scope/ranged-theme uses non-exact version spec "^1.0.0".');
		expect(latest.pinned).toBe(false);
		expect(latest.tracking).toBe(true);
		expect(latest.warnings).toContain('npm package @scope/latest-theme uses non-exact version spec "latest".');
	});

	it("pins ref-less git sources to remote HEAD by default", async () => {
		const resolved = await resolveStoreSource({
			input: "https://github.com/user/repo",
			catalog,
			gitLsRemote: async () => "0123456789abcdef0123456789abcdef01234567\tHEAD",
		});

		expect(resolved.source).toBe("git:https://github.com/user/repo@0123456789abcdef0123456789abcdef01234567");
		expect(resolved.pinned).toBe(true);
		expect(resolved.tracking).toBe(false);
	});

	it("preserves SSH clone URLs and ports when pinning ref-less git sources", async () => {
		let lsRemoteRepo: string | undefined;
		const resolved = await resolveStoreSource({
			input: "git:ssh://git@example.com:2222/user/repo",
			catalog,
			gitLsRemote: async (repo) => {
				lsRemoteRepo = repo;
				return "0123456789abcdef0123456789abcdef01234567\tHEAD";
			},
		});

		expect(lsRemoteRepo).toBe("ssh://git@example.com:2222/user/repo");
		expect(resolved.source).toBe("git:ssh://git@example.com:2222/user/repo@0123456789abcdef0123456789abcdef01234567");
		expect(resolved.pinned).toBe(true);
		expect(resolved.tracking).toBe(false);
	});

	it("preserves ref-less git sources with --track", async () => {
		const resolved = await resolveStoreSource({
			input: "https://github.com/user/repo",
			catalog,
			track: true,
		});

		expect(resolved.source).toBe("git:https://github.com/user/repo");
		expect(resolved.pinned).toBe(false);
		expect(resolved.tracking).toBe(true);
		expect(resolved.warnings).toContain(
			"Git source has no ref and will track the repository default branch if installed.",
		);
	});

	it("rejects --ref for npm sources", async () => {
		await expect(resolveStoreSource({ input: "npm:@scope/pkg@1.0.0", catalog, ref: "main" })).rejects.toThrow(
			"--ref is only valid for git store sources",
		);
	});
});
