/**
 * The store catalog (RFC §8.4): the packages `volt store` and `/store` offer.
 *
 * Each entry pins one reviewed commit of a package on an allowlisted git
 * host and repeats what the package declares at that commit: its manifest id,
 * display name, version, and permissions. The review record names the
 * reviewed commit, which is always the pinned one, so installing or updating
 * a catalog package only ever moves to a reviewed commit.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	EXTENSION_DESCRIPTION_MAX_CHARS,
	ExtensionDisplayNameSchema,
	ExtensionIdSchema,
	type ExtensionPermission,
	ExtensionPermissionsSchema,
	stringEnum,
	UI_NODE_LINE_PATTERN,
	UI_NODE_TEXT_PATTERN,
} from "@hansjm10/volt-protocol";
import { Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { formatSchemaError } from "../core/protocol/schema-errors.ts";
import { parseGitUrl } from "../utils/git.ts";

export const DEFAULT_STORE_CATALOG_URL = "https://volt-cli.dev/store/catalog.json";

const DEFAULT_STORE_CATALOG_FETCH_TIMEOUT_MS = 10000;

/** The catalog format this Volt reads. */
export const STORE_CATALOG_SCHEMA_VERSION = 2;

/**
 * Hosts a catalog entry's source may name. Entries pin a commit fetched from
 * one of them over HTTPS; the catalog parser, the resolver, and the catalog
 * check in CI refuse any other host.
 */
export const STORE_CATALOG_GIT_HOSTS: readonly string[] = ["github.com"];

export type StoreResourceType = "extensions" | "skills" | "prompts" | "themes";

export interface StoreCatalog {
	schemaVersion: typeof STORE_CATALOG_SCHEMA_VERSION;
	packages: StoreCatalogPackage[];
}

/** Who reviewed an entry's pinned commit, when, and what they checked. */
export interface StoreCatalogReview {
	/** The reviewed commit: always the commit the entry's source pins. */
	commit: string;
	reviewer: string;
	/** The review date, `YYYY-MM-DD`. */
	date: string;
	notes: string;
}

/**
 * One store package. `id`, `name`, `version`, and `permissions` repeat the
 * manifest id, display name, package version, and permissions of the package
 * at the pinned commit; the catalog check in CI verifies they match.
 */
export interface StoreCatalogPackage {
	id: string;
	name: string;
	description: string;
	version: string;
	/** `git:https://<host>/<owner>/<repo>@<commit>`: an allowlisted host and the reviewed commit. */
	source: string;
	repo: string;
	permissions: ExtensionPermission[];
	review: StoreCatalogReview;
	author: string;
	license: string;
	categories: string[];
	resources: StoreResourceType[];
	compatibility?: { volt?: string };
	image?: string;
	video?: string;
}

/** Where a catalog entry's package lives: an allowlisted host, a repository, and the pinned commit. */
export interface StoreCatalogPin {
	host: string;
	/** `<owner>/<repo>`. */
	path: string;
	/** The HTTPS clone URL. */
	repo: string;
	commit: string;
}

export interface StoreCatalogValidationResult {
	catalog: StoreCatalog;
	warnings: string[];
}

export interface LoadStoreCatalogResult {
	catalog: StoreCatalog;
	source: "remote" | "cache" | "empty";
	warnings: string[];
}

interface StoreCatalogFetchResponse {
	ok: boolean;
	status: number;
	text(): Promise<string>;
}

interface StoreCatalogFetchOptions {
	signal?: AbortSignal;
}

export type StoreCatalogFetcher = (
	url: string,
	options?: StoreCatalogFetchOptions,
) => Promise<StoreCatalogFetchResponse>;

export interface LoadDefaultStoreCatalogOptions {
	agentDir: string;
	url?: string;
	offline?: boolean;
	fetcher?: StoreCatalogFetcher;
	timeoutMs?: number;
}

const closed = { additionalProperties: false } as const;

function line(maxLength: number) {
	return Type.String({
		minLength: 1,
		maxLength,
		pattern: UI_NODE_LINE_PATTERN,
		"x-volt-expected": `be one non-empty line of at most ${maxLength} characters without control characters`,
	});
}

function text(maxLength: number) {
	return Type.String({
		minLength: 1,
		maxLength,
		pattern: UI_NODE_TEXT_PATTERN,
		"x-volt-expected": `be non-empty text of at most ${maxLength} characters without control characters`,
	});
}

const HttpsUrlSchema = Type.String({
	maxLength: 2048,
	pattern: "^https://\\S+$",
	"x-volt-expected": "be an https URL",
});

const CommitSchema = Type.String({
	pattern: "^[0-9a-f]{40}$",
	"x-volt-expected": "be a full 40-character lowercase commit hash",
});

const StoreCatalogReviewSchema = Type.Object(
	{
		commit: CommitSchema,
		reviewer: line(80),
		date: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$", "x-volt-expected": "be a date written YYYY-MM-DD" }),
		notes: text(2000),
	},
	closed,
);

const StoreCatalogPackageSchema = Type.Object(
	{
		id: ExtensionIdSchema,
		name: ExtensionDisplayNameSchema,
		description: text(EXTENSION_DESCRIPTION_MAX_CHARS),
		version: Type.String({
			minLength: 1,
			maxLength: 64,
			pattern: "^[0-9A-Za-z.+-]+$",
			"x-volt-expected": "be a package version",
		}),
		source: Type.String({
			maxLength: 512,
			pattern: UI_NODE_LINE_PATTERN,
			"x-volt-expected": "be one line without control characters",
		}),
		repo: HttpsUrlSchema,
		permissions: ExtensionPermissionsSchema,
		review: StoreCatalogReviewSchema,
		author: line(80),
		license: line(80),
		categories: Type.Array(
			Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,39}$", "x-volt-expected": "be a lowercase category slug" }),
			{ maxItems: 10, uniqueItems: true },
		),
		resources: Type.Array(stringEnum(["extensions", "skills", "prompts", "themes"]), { uniqueItems: true }),
		compatibility: Type.Optional(Type.Object({ volt: Type.Optional(line(64)) }, closed)),
		image: Type.Optional(HttpsUrlSchema),
		video: Type.Optional(HttpsUrlSchema),
	},
	closed,
);

const SOURCE_PATTERN = /^git:https:\/\/([^/@\s]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([0-9a-f]{40})$/;

let packageValidator: Validator | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a catalog entry's source, `git:https://<host>/<owner>/<repo>@<commit>`.
 * Throws unless it names an allowlisted host and a full commit, in the form
 * the package manager reads the same way.
 */
export function parseStoreCatalogSource(source: string): StoreCatalogPin {
	const match = SOURCE_PATTERN.exec(source);
	if (!match) {
		throw new Error(`source must be git:https://<host>/<owner>/<repo>@<40-character commit>, got ${source}`);
	}
	const [, host = "", owner = "", name = "", commit = ""] = match;
	if (!STORE_CATALOG_GIT_HOSTS.includes(host)) {
		throw new Error(`source host ${host} is not allowed; catalog sources use ${STORE_CATALOG_GIT_HOSTS.join(", ")}`);
	}
	if (owner.startsWith(".") || name.startsWith(".") || name.endsWith(".git")) {
		throw new Error(`source must name <owner>/<repo> without a leading dot or a .git suffix, got ${owner}/${name}`);
	}
	const path = `${owner}/${name}`;
	const repo = `https://${host}/${path}`;
	// The package manager installs whatever parseGitUrl reads from the source; it must read this one the same way.
	const parsed = parseGitUrl(source);
	if (parsed?.host !== host || parsed.path !== path || parsed.repo !== repo || parsed.ref !== commit) {
		throw new Error(`source ${source} does not parse as ${repo} at ${commit}`);
	}
	return { host, path, repo, commit };
}

/**
 * Where a catalog package installs from. Throws unless its source names an
 * allowlisted host and its review record covers the pinned commit.
 */
export function getCatalogPackagePin(pkg: StoreCatalogPackage): StoreCatalogPin {
	const pin = parseStoreCatalogSource(pkg.source);
	if (pkg.review.commit !== pin.commit) {
		throw new Error(`review.commit ${pkg.review.commit} is not the pinned commit ${pin.commit}`);
	}
	return pin;
}

function isCalendarDate(value: string): boolean {
	const date = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isHttpsUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.hostname !== "" && url.username === "" && url.password === "";
	} catch {
		return false;
	}
}

function validateCatalogPackage(value: unknown): { pkg: StoreCatalogPackage } | { error: string } {
	packageValidator ??= Compile(StoreCatalogPackageSchema);
	if (!packageValidator.Check(value)) {
		return { error: formatSchemaError(StoreCatalogPackageSchema, packageValidator.Errors(value)) };
	}
	const pkg: StoreCatalogPackage = structuredClone(value as StoreCatalogPackage);
	try {
		getCatalogPackagePin(pkg);
	} catch (error: unknown) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
	if (!isCalendarDate(pkg.review.date)) {
		return { error: `review.date ${pkg.review.date} is not a calendar date` };
	}
	for (const field of ["repo", "image", "video"] as const) {
		const url = pkg[field];
		if (url !== undefined && !isHttpsUrl(url)) {
			return { error: `${field} must be an https URL without credentials` };
		}
	}
	return { pkg };
}

export function validateStoreCatalog(value: unknown): StoreCatalogValidationResult {
	if (!isRecord(value)) {
		throw new Error("Store catalog must be a JSON object");
	}
	if (value.schemaVersion !== STORE_CATALOG_SCHEMA_VERSION) {
		throw new Error(`Store catalog schemaVersion must be ${STORE_CATALOG_SCHEMA_VERSION}`);
	}
	if (!Array.isArray(value.packages)) {
		throw new Error("Store catalog packages must be an array");
	}
	const unknownField = Object.keys(value).find((key) => key !== "schemaVersion" && key !== "packages");
	if (unknownField !== undefined) {
		throw new Error(`Store catalog field "${unknownField}" is not recognized`);
	}

	const warnings: string[] = [];
	const packages: StoreCatalogPackage[] = [];
	const seenIds = new Set<string>();
	for (let index = 0; index < value.packages.length; index++) {
		const result = validateCatalogPackage(value.packages[index]);
		if ("error" in result) {
			warnings.push(`Skipping invalid catalog package at index ${index}: ${result.error}`);
			continue;
		}
		if (seenIds.has(result.pkg.id)) {
			warnings.push(`Skipping duplicate catalog package id "${result.pkg.id}" at index ${index}`);
			continue;
		}
		seenIds.add(result.pkg.id);
		packages.push(result.pkg);
	}

	return {
		catalog: { schemaVersion: STORE_CATALOG_SCHEMA_VERSION, packages },
		warnings,
	};
}

export function parseStoreCatalogJson(raw: string, label = "store catalog"): StoreCatalogValidationResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to parse ${label}: ${message}`);
	}
	return validateStoreCatalog(parsed);
}

export function getStoreCatalogCachePath(agentDir: string, url = getDefaultCatalogUrl()): string {
	const cacheKey = createHash("sha256").update(url).digest("hex");
	return join(agentDir, "store", "catalogs", `${cacheKey}.json`);
}

function isOfflineModeEnabled(): boolean {
	const value = process.env.VOLT_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function getDefaultCatalogUrl(url?: string): string {
	return url ?? process.env.VOLT_STORE_CATALOG_URL ?? DEFAULT_STORE_CATALOG_URL;
}

function readCachedCatalog(agentDir: string, url: string): LoadStoreCatalogResult | undefined {
	const cachePath = getStoreCatalogCachePath(agentDir, url);
	if (!existsSync(cachePath)) {
		return undefined;
	}

	const result = parseStoreCatalogJson(readFileSync(cachePath, "utf-8"), "cached store catalog");
	return {
		catalog: result.catalog,
		source: "cache",
		warnings: result.warnings,
	};
}

function writeCachedCatalog(agentDir: string, url: string, raw: string): void {
	const cachePath = getStoreCatalogCachePath(agentDir, url);
	mkdirSync(join(agentDir, "store", "catalogs"), { recursive: true, mode: 0o700 });
	writeFileSync(cachePath, raw, "utf-8");
}

async function withCatalogFetchTimeout<T>(
	timeoutMs: number,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	const timeoutMessage = `Store catalog fetch timed out after ${timeoutMs}ms`;

	try {
		return await new Promise<T>((resolve, reject) => {
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(new Error(timeoutMessage));
			}, timeoutMs);
			operation(controller.signal).then(resolve, reject);
		});
	} catch (error: unknown) {
		if (timedOut) {
			throw new Error(timeoutMessage);
		}
		throw error;
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

export async function loadDefaultStoreCatalog(
	options: LoadDefaultStoreCatalogOptions,
): Promise<LoadStoreCatalogResult> {
	const url = getDefaultCatalogUrl(options.url);
	const offline = options.offline ?? isOfflineModeEnabled();
	if (offline) {
		try {
			const cached = readCachedCatalog(options.agentDir, url);
			if (cached) {
				return {
					...cached,
					warnings: ["Offline mode enabled; using cached store catalog.", ...cached.warnings],
				};
			}
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				catalog: { schemaVersion: STORE_CATALOG_SCHEMA_VERSION, packages: [] },
				source: "empty",
				warnings: [`Offline mode enabled and cached store catalog is invalid: ${message}`],
			};
		}
		return {
			catalog: { schemaVersion: STORE_CATALOG_SCHEMA_VERSION, packages: [] },
			source: "empty",
			warnings: ["Offline mode enabled and no cached store catalog is available."],
		};
	}

	const fetcher: StoreCatalogFetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
	const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_STORE_CATALOG_FETCH_TIMEOUT_MS));
	try {
		const { raw, result } = await withCatalogFetchTimeout(timeoutMs, async (signal) => {
			const response = await fetcher(url, { signal });
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}
			const rawCatalog = await response.text();
			return {
				raw: rawCatalog,
				result: parseStoreCatalogJson(rawCatalog, "remote store catalog"),
			};
		});
		const warnings = [...result.warnings];
		try {
			writeCachedCatalog(options.agentDir, url, raw);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : String(error);
			warnings.push(`Failed to cache remote store catalog: ${message}`);
		}
		return {
			catalog: result.catalog,
			source: "remote",
			warnings,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const cached = readCachedCatalog(options.agentDir, url);
		if (cached) {
			return {
				...cached,
				warnings: [`Failed to load remote store catalog (${message}); using cached catalog.`, ...cached.warnings],
			};
		}
		throw new Error(`Failed to load store catalog: ${message}`);
	}
}

export function findCatalogPackage(catalog: StoreCatalog, id: string): StoreCatalogPackage | undefined {
	return catalog.packages.find((pkg) => pkg.id === id);
}

export function searchCatalogPackages(catalog: StoreCatalog, query?: string): StoreCatalogPackage[] {
	const normalizedQuery = query?.trim().toLowerCase();
	if (!normalizedQuery) {
		return [...catalog.packages];
	}

	return catalog.packages.filter((pkg) => {
		const fields = [pkg.id, pkg.name, pkg.description, ...(pkg.categories ?? [])];
		return fields.some((field) => field.toLowerCase().includes(normalizedQuery));
	});
}

function levenshteinDistance(left: string, right: string): number {
	const previous = new Array<number>(right.length + 1);
	const current = new Array<number>(right.length + 1);
	for (let index = 0; index <= right.length; index++) {
		previous[index] = index;
	}
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		current[0] = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
			current[rightIndex] = Math.min(
				current[rightIndex - 1] + 1,
				previous[rightIndex] + 1,
				previous[rightIndex - 1] + cost,
			);
		}
		for (let index = 0; index <= right.length; index++) {
			previous[index] = current[index];
		}
	}
	return previous[right.length] ?? 0;
}

export function suggestCatalogPackageIds(catalog: StoreCatalog, input: string, limit = 3): string[] {
	const normalizedInput = input.toLowerCase();
	return catalog.packages
		.map((pkg) => ({
			id: pkg.id,
			score: pkg.id.toLowerCase().includes(normalizedInput)
				? 0
				: levenshteinDistance(normalizedInput, pkg.id.toLowerCase()),
		}))
		.filter((entry) => entry.score <= Math.max(2, Math.floor(normalizedInput.length / 2)))
		.sort((left, right) => left.score - right.score || left.id.localeCompare(right.id))
		.slice(0, limit)
		.map((entry) => entry.id);
}
