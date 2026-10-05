import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getCatalogPackagePin,
	getStoreCatalogCachePath,
	loadDefaultStoreCatalog,
	parseStoreCatalogJson,
	parseStoreCatalogSource,
	searchCatalogPackages,
	validateStoreCatalog,
} from "../src/store/catalog.ts";
import {
	NEXT_TEST_STORE_COMMIT,
	TEST_STORE_COMMIT,
	testCatalog,
	testCatalogEntry,
	testStoreSource,
} from "./store-catalog-fixtures.ts";

describe("store catalog", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-store-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("parses the catalog the site serves without warnings", () => {
		const raw = readFileSync(new URL("../../../site/public/store/catalog.json", import.meta.url), "utf-8");

		const result = parseStoreCatalogJson(raw);

		expect(result.warnings).toEqual([]);
		expect(result.catalog.packages.length).toBeGreaterThan(0);
		for (const pkg of result.catalog.packages) {
			expect(getCatalogPackagePin(pkg).commit).toBe(pkg.review.commit);
		}
	});

	it("validates entries and skips malformed or duplicate packages", () => {
		const { description: _description, ...withoutDescription } = testCatalogEntry("bad");
		const result = validateStoreCatalog(
			testCatalog(
				testCatalogEntry("rtk"),
				withoutDescription as never,
				testCatalogEntry("rtk", { name: "Duplicate" }),
			),
		);

		expect(result.catalog.packages.map((pkg) => pkg.name)).toEqual(["RTK Output Compression"]);
		expect(result.warnings).toEqual([
			'Skipping invalid catalog package at index 1: "description" is required',
			'Skipping duplicate catalog package id "rtk" at index 2',
		]);
	});

	it.each([
		["the removed verified flag", { verified: true }, '"verified" is not a recognized field'],
		["an id that is not a manifest id", { id: "Not An Id" }, '"id" must be a lowercase extension id'],
		["an unknown permission", { permissions: ["root"] }, '"permissions[0]" must be'],
		["a name with terminal escapes", { name: "RTK \u001b[31mred" }, '"name" must be one non-empty line'],
		["a plain-http repo link", { repo: "http://github.com/volt-hq/Volt" }, '"repo" must be an https URL'],
		[
			"a repo link with credentials",
			{ repo: "https://user:token@github.com/volt-hq/Volt" },
			"repo must be an https URL without credentials",
		],
		["an npm source", { source: "npm:volt-rtk@0.2.0" }, "source must be git:https://"],
		["a branch ref", { source: "git:https://github.com/volt-hq/Volt@main" }, "source must be git:https://"],
		[
			"a host off the allowlist",
			{ source: `git:https://gitlab.com/volt-hq/Volt@${TEST_STORE_COMMIT}` },
			"source host gitlab.com is not allowed",
		],
		[
			"a review of another commit",
			{ source: testStoreSource(NEXT_TEST_STORE_COMMIT) },
			`review.commit ${TEST_STORE_COMMIT} is not the pinned commit ${NEXT_TEST_STORE_COMMIT}`,
		],
		[
			"a review date that is not a date",
			{ review: { commit: TEST_STORE_COMMIT, reviewer: "hansjm10", date: "2026-02-30", notes: "Reviewed." } },
			"review.date 2026-02-30 is not a calendar date",
		],
	])("skips an entry with %s", (_label, overrides, warning) => {
		const result = validateStoreCatalog(testCatalog({ ...testCatalogEntry("rtk"), ...overrides } as never));

		expect(result.catalog.packages).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain(warning);
	});

	it("keeps terminal sequences and line breaks from catalog keys out of warnings", () => {
		const result = validateStoreCatalog(
			testCatalog({ ...testCatalogEntry("rtk"), "\u001b[2J\nPermissions: none\u009b1A": true } as never),
		);

		expect(result.warnings).toEqual([
			'Skipping invalid catalog package at index 0: " Permissions: none" is not a recognized field',
		]);
	});

	it("rejects other schema versions and unknown top-level fields", () => {
		expect(() => validateStoreCatalog({ schemaVersion: 1, packages: [] })).toThrow(
			"Store catalog schemaVersion must be 2",
		);
		expect(() => validateStoreCatalog({ schemaVersion: 2, packages: [], mirror: "x" })).toThrow(
			'Store catalog field "mirror" is not recognized',
		);
	});

	it.each([
		["shorthand", `git:github.com/volt-hq/Volt@${TEST_STORE_COMMIT}`],
		["plain http", `git:http://github.com/volt-hq/Volt@${TEST_STORE_COMMIT}`],
		["ssh", `git:ssh://git@github.com/volt-hq/Volt@${TEST_STORE_COMMIT}`],
		["a port", `git:https://github.com:443/volt-hq/Volt@${TEST_STORE_COMMIT}`],
		["credentials", `git:https://token@github.com/volt-hq/Volt@${TEST_STORE_COMMIT}`],
		["a .git suffix", `git:https://github.com/volt-hq/Volt.git@${TEST_STORE_COMMIT}`],
		["a dot segment", `git:https://github.com/volt-hq/..@${TEST_STORE_COMMIT}`],
		["a nested path", `git:https://github.com/volt-hq/Volt/sub@${TEST_STORE_COMMIT}`],
		["an abbreviated commit", "git:https://github.com/volt-hq/Volt@0123456789ab"],
		["an uppercase commit", `git:https://github.com/volt-hq/Volt@${TEST_STORE_COMMIT.toUpperCase()}`],
	])("refuses a catalog source with %s", (_label, source) => {
		expect(() => parseStoreCatalogSource(source)).toThrow();
	});

	it("reads a canonical catalog source as the package manager does", () => {
		expect(parseStoreCatalogSource(testStoreSource())).toEqual({
			host: "github.com",
			path: "volt-hq/Volt",
			repo: "https://github.com/volt-hq/Volt",
			commit: TEST_STORE_COMMIT,
		});
	});

	it("searches ids, names, descriptions, and categories case-insensitively", () => {
		const catalog = validateStoreCatalog(
			testCatalog(
				testCatalogEntry("rtk", { categories: ["shell"] }),
				testCatalogEntry("theme-dark", {
					name: "Dark Theme",
					description: "Theme package",
					categories: ["theme"],
				}),
			),
		).catalog;

		expect(searchCatalogPackages(catalog, "SHELL").map((pkg) => pkg.id)).toEqual(["rtk"]);
		expect(searchCatalogPackages(catalog, "theme").map((pkg) => pkg.id)).toEqual(["theme-dark"]);
		expect(searchCatalogPackages(catalog, "token").map((pkg) => pkg.id)).toEqual(["rtk"]);
	});

	it("fetches and caches the default catalog", async () => {
		const fetcher = vi.fn(async () => Response.json(testCatalog()));

		const result = await loadDefaultStoreCatalog({ agentDir: tempDir, fetcher });

		expect(result.source).toBe("remote");
		expect(fetcher).toHaveBeenCalledOnce();
		expect(JSON.parse(readFileSync(getStoreCatalogCachePath(tempDir), "utf-8"))).toEqual(testCatalog());
	});

	it("keeps the remote catalog when cache persistence fails", async () => {
		const agentDir = join(tempDir, "agent-file");
		writeFileSync(agentDir, "not a directory");
		const fetcher = vi.fn(async () => Response.json(testCatalog(testCatalogEntry("remote"))));

		const result = await loadDefaultStoreCatalog({ agentDir, fetcher });

		expect(result.source).toBe("remote");
		expect(result.catalog.packages.map((pkg) => pkg.id)).toEqual(["remote"]);
		expect(result.warnings).toEqual([expect.stringContaining("Failed to cache remote store catalog")]);
	});

	it("uses the cached catalog in offline mode", async () => {
		const fetcher = vi.fn(async () => Response.json(testCatalog()));
		await loadDefaultStoreCatalog({ agentDir: tempDir, fetcher });

		const result = await loadDefaultStoreCatalog({ agentDir: tempDir, offline: true });

		expect(result.source).toBe("cache");
		expect(result.warnings[0]).toBe("Offline mode enabled; using cached store catalog.");
	});

	it("does not fall back to a cached catalog from a different URL", async () => {
		await loadDefaultStoreCatalog({
			agentDir: tempDir,
			url: "https://example.test/catalog-a.json",
			fetcher: vi.fn(async () => Response.json(testCatalog(testCatalogEntry("from-a")))),
		});

		await expect(
			loadDefaultStoreCatalog({
				agentDir: tempDir,
				url: "https://example.test/catalog-b.json",
				fetcher: vi.fn(async () => {
					throw new Error("network down");
				}),
			}),
		).rejects.toThrow("Failed to load store catalog: network down");
	});

	it("falls back to the cached catalog when the remote fetch times out", async () => {
		await loadDefaultStoreCatalog({
			agentDir: tempDir,
			fetcher: vi.fn(async () => Response.json(testCatalog(testCatalogEntry("cached")))),
		});
		const fetcher = vi.fn(() => new Promise<never>(() => {}));
		const options = { agentDir: tempDir, fetcher, timeoutMs: 5 };

		const result = await Promise.race([
			loadDefaultStoreCatalog(options),
			new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
		]);

		expect(result).not.toBe("hung");
		if (result === "hung") return;
		expect(result.source).toBe("cache");
		expect(result.catalog.packages.map((pkg) => pkg.id)).toEqual(["cached"]);
		expect(result.warnings[0]).toContain("Failed to load remote store catalog");
		expect(result.warnings[0]).toContain("using cached catalog");
	});
});
