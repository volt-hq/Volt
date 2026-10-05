/**
 * Extension manifests (RFC §8.1): what an extension declares about itself.
 *
 * A package declares its manifest in the `volt` field of package.json, read
 * as JSON: the host never runs package code to learn a package's id or
 * permissions. `entry` names the module the package loads, inside the
 * package. The field may also list the package's `skills`, `prompts`, and
 * `themes`, and carry `image` and `video` previews; a field with only those
 * declares no extension.
 *
 * A single-file extension exports `manifest`. Reading it evaluates the
 * module, so single-file extensions load only from trusted locations: the
 * user's and a trusted project's extension directories and settings, and
 * paths given for one run; never an npm or git package. An SDK extension
 * passes its manifest with its factory.
 *
 * The manifest id is the extension's identity. It never comes from a path.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type ExtensionManifest, ExtensionManifestSchema, UI_NODE_LINE_PATTERN } from "@hansjm10/volt-protocol";
import { Compile, type Validator } from "typebox/compile";
import { CanonicalDataError, cloneCanonicalData } from "../canonical-data.ts";
import { formatSchemaError } from "../protocol/schema-errors.ts";
import { checkSettingsSchema, ExtensionSettingsError, normalizeSettingsSchema } from "./settings.ts";

export type { ExtensionManifest } from "@hansjm10/volt-protocol";

/** The version of an extension without a package version: a single file, an SDK extension, or an unversioned package. */
export const LOCAL_EXTENSION_VERSION = "local";

/** Keys of a package's `volt` field that list resources or carry previews instead of declaring an extension. */
const PACKAGE_RESOURCE_KEYS: ReadonlySet<string> = new Set(["skills", "prompts", "themes", "image", "video"]);

/** Longest package version kept, in characters. */
const VERSION_MAX_CHARS = 256;
const VERSION_PATTERN = new RegExp(UI_NODE_LINE_PATTERN, "u");

let manifestValidator: Validator | undefined;

/** A manifest that cannot be read or does not validate; its message says what to fix. */
export class ExtensionManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExtensionManifestError";
	}
}

/**
 * Declare a single-file or SDK extension's manifest:
 * `export const manifest = defineManifest({ id: "my-tool", displayName: "My Tool" })`.
 */
export function defineManifest<const T extends ExtensionManifest>(manifest: T): T {
	return manifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

/** `value` with TypeBox settings output read as the settings schema (see {@link normalizeSettingsSchema}). */
function withNormalizedSettings(value: unknown): unknown {
	if (!isRecord(value) || !Object.hasOwn(value, "settings")) return value;
	const normalized: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		Object.defineProperty(normalized, key, {
			value: key === "settings" ? normalizeSettingsSchema(child) : child,
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return normalized;
}

/**
 * Check a manifest and return a frozen copy of it. A package's manifest names
 * its `entry`; a single-file or SDK extension's has none. Settings written as
 * TypeBox output are accepted (string literal unions read as string enums),
 * and must hold together: valid defaults, ordered bounds, safe patterns,
 * declared `required` names, and no credentials. Throws an
 * {@link ExtensionManifestError} naming the first problem.
 */
export function validateManifest(value: unknown, options: { readonly package: boolean }): ExtensionManifest {
	let manifest: unknown;
	try {
		// Read once: what is checked is what is kept.
		manifest = cloneCanonicalData(withNormalizedSettings(value), "The manifest");
	} catch (error) {
		throw new ExtensionManifestError(error instanceof CanonicalDataError ? error.message : String(error));
	}
	if (!isRecord(manifest)) throw new ExtensionManifestError("The manifest must be an object");
	manifestValidator ??= Compile(ExtensionManifestSchema);
	if (!manifestValidator.Check(manifest)) {
		throw new ExtensionManifestError(formatSchemaError(ExtensionManifestSchema, manifestValidator.Errors(manifest)));
	}
	if (options.package && manifest.entry === undefined) {
		throw new ExtensionManifestError(`"entry" is required: name the module the package loads`);
	}
	if (!options.package && manifest.entry !== undefined) {
		throw new ExtensionManifestError(`"entry" names a package's module; a single-file extension has none`);
	}
	const checked = manifest as ExtensionManifest;
	if (checked.settings !== undefined) {
		try {
			checkSettingsSchema(checked.settings);
		} catch (error) {
			if (error instanceof ExtensionSettingsError) throw new ExtensionManifestError(error.message);
			throw error;
		}
	}
	return deepFreeze(checked);
}

/** The `volt` field of `root/package.json`; undefined when there is none or the file cannot be read. */
function readVoltField(root: string): { readonly volt: unknown; readonly version: unknown } | undefined {
	const packageJsonPath = join(root, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;
	let pkg: unknown;
	try {
		pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!isRecord(pkg) || pkg.volt === undefined) return undefined;
	return { volt: pkg.volt, version: pkg.version };
}

/**
 * Whether `root/package.json` declares an extension: its `volt` field has a
 * key besides `skills`, `prompts`, `themes`, `image`, and `video`. Such a
 * package loads only through its manifest.
 */
export function declaresPackageExtension(root: string): boolean {
	const field = readVoltField(root);
	if (field === undefined) return false;
	if (!isRecord(field.volt)) return true;
	return Object.keys(field.volt).some((key) => !PACKAGE_RESOURCE_KEYS.has(key));
}

/** A package's extension: its manifest, version, and entry module. */
export interface PackageExtension {
	readonly manifest: ExtensionManifest;
	/** The package version, or `local` when package.json has none. */
	readonly version: string;
	/** The entry module's real path, inside the package root. */
	readonly entryPath: string;
}

function isInside(root: string, target: string): boolean {
	const path = relative(root, target);
	return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}

/** The real path of `entry` in the package at `root`; throws unless it is a file inside the package. */
function resolvePackageEntry(root: string, entry: string): string {
	// The schema already refuses absolute paths, drive letters, backslashes, and `..` segments.
	const realRoot = realpathSync(root);
	const candidate = resolve(realRoot, entry);
	if (!isInside(realRoot, candidate)) {
		throw new ExtensionManifestError(`"entry" ${JSON.stringify(entry)} is not inside the package`);
	}
	if (!existsSync(candidate)) {
		throw new ExtensionManifestError(`"entry" ${JSON.stringify(entry)} does not exist in the package`);
	}
	// A symbolic link inside the package must not lead out of it.
	const realEntry = realpathSync(candidate);
	if (!isInside(realRoot, realEntry)) {
		throw new ExtensionManifestError(`"entry" ${JSON.stringify(entry)} resolves outside the package`);
	}
	if (!statSync(realEntry).isFile()) {
		throw new ExtensionManifestError(`"entry" ${JSON.stringify(entry)} is not a file`);
	}
	return realEntry;
}

function packageVersion(version: unknown): string {
	return typeof version === "string" &&
		version.length > 0 &&
		version.length <= VERSION_MAX_CHARS &&
		VERSION_PATTERN.test(version)
		? version
		: LOCAL_EXTENSION_VERSION;
}

/**
 * The extension the package at `root` declares in package.json, read as JSON
 * without running package code; undefined when it declares none. Throws an
 * {@link ExtensionManifestError} when the declaration is invalid or its entry
 * is not a file inside the package.
 */
export function readPackageManifest(root: string): PackageExtension | undefined {
	if (!declaresPackageExtension(root)) return undefined;
	const field = readVoltField(root);
	if (field === undefined || !isRecord(field.volt)) {
		throw new ExtensionManifestError(`The "volt" field of package.json must be an object`);
	}
	// Own data properties only, so a `__proto__` key is a field the schema refuses.
	const declared = Object.fromEntries(Object.entries(field.volt).filter(([key]) => !PACKAGE_RESOURCE_KEYS.has(key)));
	if (declared.extensions !== undefined) {
		throw new ExtensionManifestError(
			`"volt.extensions" is replaced by the manifest: declare the package's one extension with "id", "displayName", and "entry"`,
		);
	}
	const manifest = validateManifest(declared, { package: true });
	const entryPath = resolvePackageEntry(root, manifest.entry ?? "");
	return { manifest, version: packageVersion(field.version), entryPath };
}

/**
 * The manifest a single-file extension's module exports as `manifest`.
 * Throws an {@link ExtensionManifestError} when it exports none or an invalid one.
 */
export function readModuleManifest(module: unknown): ExtensionManifest {
	const manifest =
		(typeof module === "object" && module !== null) || typeof module === "function"
			? Reflect.get(module, "manifest")
			: undefined;
	if (manifest === undefined) {
		throw new ExtensionManifestError(
			`The module exports no manifest: add \`export const manifest = defineManifest({ id, displayName })\``,
		);
	}
	return validateManifest(manifest, { package: false });
}
