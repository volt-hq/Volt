/**
 * Extensions (RFC §8): the manifest an extension declares, the settings
 * subset every client renders as a form, the permissions it asks for, and the
 * summary the `extensions` query lists.
 *
 * A package declares its manifest in the `volt` field of package.json; a
 * single-file extension exports `manifest`. The manifest id is the
 * extension's identity: contributions, settings (`extensions.<id>` in global
 * or project settings), work kinds (`ext:<id>/<kind>`), and live keys are
 * keyed by it. The version comes from the package.
 *
 * Settings are a flat object of string, string enum, boolean, and integer
 * properties, written as the JSON Schema TypeBox emits: enums are
 * `{type: "string", enum}`.
 */

import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { UI_NODE_LINE_PATTERN, UI_NODE_TEXT_PATTERN, UiNodeFormFieldSchema } from "./ui-node.ts";

const closed = { additionalProperties: false } as const;

// ============================================================================
// Limits
// ============================================================================

/** Ids extensions may not take: they name the host and its built-in sources. */
export const RESERVED_EXTENSION_IDS = ["volt", "core", "builtin", "host", "ext"] as const;
/** An extension id: lowercase letters, digits, and dashes, at most 64 characters, not reserved. */
export const EXTENSION_ID_PATTERN = `^(?!(?:${RESERVED_EXTENSION_IDS.join("|")})$)[a-z0-9][a-z0-9-]{0,63}$`;
/** Longest display name, in characters. */
export const EXTENSION_DISPLAY_NAME_MAX_CHARS = 80;
/** Longest description, in characters. */
export const EXTENSION_DESCRIPTION_MAX_CHARS = 240;
/** Longest package entry path, in characters. */
export const EXTENSION_ENTRY_MAX_CHARS = 512;
/** A relative path inside the package: not absolute, no drive letter, no `..` segment, no backslash. */
export const EXTENSION_ENTRY_PATTERN = "^(?!/|[A-Za-z]:)(?!(?:[^/]*/)*\\.\\.(?:/|$))[^\\\\\\u0000-\\u001f\\u007f]+$";
/** A setting name: a letter, then letters, digits, and underscores; never `constructor` or `prototype`. */
export const EXTENSION_SETTING_NAME_PATTERN = "^(?!(?:constructor|prototype)$)[A-Za-z][A-Za-z0-9_]{0,63}$";
/** Longest string setting pattern, in characters. */
export const EXTENSION_SETTING_PATTERN_MAX_CHARS = 512;
/** Largest stored settings of one extension in one scope, as serialized JSON in UTF-8 bytes. */
export const EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES = 16 * 1024;
/** Longest load or activation error a summary carries, in characters. */
export const EXTENSION_ERROR_MAX_CHARS = 2_000;

/** The `x-volt-limits` block for extensions. */
export const EXTENSION_LIMITS = {
	idPattern: EXTENSION_ID_PATTERN,
	reservedIds: RESERVED_EXTENSION_IDS,
	displayNameMaxChars: EXTENSION_DISPLAY_NAME_MAX_CHARS,
	descriptionMaxChars: EXTENSION_DESCRIPTION_MAX_CHARS,
	entryMaxChars: EXTENSION_ENTRY_MAX_CHARS,
	settingNamePattern: EXTENSION_SETTING_NAME_PATTERN,
	settingPatternMaxChars: EXTENSION_SETTING_PATTERN_MAX_CHARS,
	settingsMaxSerializedBytes: EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES,
	errorMaxChars: EXTENSION_ERROR_MAX_CHARS,
} as const;

// ============================================================================
// Identity and permissions
// ============================================================================

export const ExtensionIdSchema = Type.String({
	pattern: EXTENSION_ID_PATTERN,
	"x-volt-expected": "be a lowercase extension id that is not reserved",
});

export const ExtensionDisplayNameSchema = Type.String({
	minLength: 1,
	maxLength: EXTENSION_DISPLAY_NAME_MAX_CHARS,
	pattern: UI_NODE_LINE_PATTERN,
	"x-volt-expected": "be one non-empty line without terminal control sequences",
});

export const ExtensionDescriptionSchema = Type.String({
	maxLength: EXTENSION_DESCRIPTION_MAX_CHARS,
	pattern: UI_NODE_TEXT_PATTERN,
	"x-volt-expected": "be text without terminal control sequences",
});

/**
 * What an extension may do beyond the conversation: run commands, use the
 * network, write files, read credentials, or register model providers.
 * Advisory: in-process extensions are not sandboxed (RFC Q2).
 */
export const EXTENSION_PERMISSIONS = ["exec", "network", "fs-write", "secrets", "providers"] as const;
export const ExtensionPermissionSchema = stringEnum(EXTENSION_PERMISSIONS);
export type ExtensionPermission = Static<typeof ExtensionPermissionSchema>;

export const ExtensionPermissionsSchema = Type.Array(ExtensionPermissionSchema, {
	maxItems: EXTENSION_PERMISSIONS.length,
	uniqueItems: true,
});

// ============================================================================
// Settings
// ============================================================================

const settingName = Type.String({
	pattern: EXTENSION_SETTING_NAME_PATTERN,
	"x-volt-expected": "be a setting name",
});

const settingBase = {
	title: Type.Optional(ExtensionDisplayNameSchema),
	description: Type.Optional(ExtensionDescriptionSchema),
};

/** One setting: a string (optionally bounded and patterned), a string enum, a boolean, or an integer. */
export const ExtensionSettingSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("string"),
			...settingBase,
			default: Type.Optional(Type.String()),
			minLength: Type.Optional(Type.Integer({ minimum: 0 })),
			maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
			/** ECMAScript pattern the whole value must match. */
			pattern: Type.Optional(Type.String({ maxLength: EXTENSION_SETTING_PATTERN_MAX_CHARS })),
		},
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("string"),
			enum: Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
			...settingBase,
			default: Type.Optional(Type.String()),
		},
		closed,
	),
	Type.Object({ type: Type.Literal("boolean"), ...settingBase, default: Type.Optional(Type.Boolean()) }, closed),
	Type.Object(
		{
			type: Type.Literal("integer"),
			...settingBase,
			default: Type.Optional(Type.Integer()),
			minimum: Type.Optional(Type.Integer()),
			maximum: Type.Optional(Type.Integer()),
		},
		closed,
	),
]);
export type ExtensionSetting = Static<typeof ExtensionSettingSchema>;

/** The settings schema a manifest declares: a flat object of settings. */
export const ExtensionSettingsSchema = Type.Object(
	{
		type: Type.Literal("object"),
		properties: Type.Record(settingName, ExtensionSettingSchema, closed),
		required: Type.Optional(Type.Array(settingName, { uniqueItems: true })),
		additionalProperties: Type.Optional(Type.Literal(false)),
	},
	closed,
);
export type ExtensionSettings = Static<typeof ExtensionSettingsSchema>;

/** Setting values by name. */
export const ExtensionSettingsValuesSchema = Type.Record(
	settingName,
	Type.Union([Type.String(), Type.Boolean(), Type.Integer()]),
	{ ...closed, "x-volt-max-serialized-bytes": EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES },
);
export type ExtensionSettingsValues = Static<typeof ExtensionSettingsValuesSchema>;

/** Where settings are stored: the user's global settings, or the project's (trusted projects only). */
export const ExtensionSettingsScopeSchema = stringEnum(["global", "project"]);
export type ExtensionSettingsScope = Static<typeof ExtensionSettingsScopeSchema>;

// ============================================================================
// Manifest
// ============================================================================

/** A package's entry module, relative to and inside the package root. */
export const ExtensionEntrySchema = Type.String({
	maxLength: EXTENSION_ENTRY_MAX_CHARS,
	pattern: EXTENSION_ENTRY_PATTERN,
	"x-volt-expected": "be a relative path inside the package",
});

/**
 * What an extension declares. `entry` names a package's entry module; a
 * single-file extension, whose module is its entry, has none.
 */
export const ExtensionManifestSchema = Type.Object(
	{
		id: ExtensionIdSchema,
		displayName: ExtensionDisplayNameSchema,
		description: Type.Optional(ExtensionDescriptionSchema),
		entry: Type.Optional(ExtensionEntrySchema),
		settings: Type.Optional(ExtensionSettingsSchema),
		permissions: Type.Optional(ExtensionPermissionsSchema),
	},
	closed,
);
export type ExtensionManifest = Static<typeof ExtensionManifestSchema>;

// ============================================================================
// Summaries and settings views
// ============================================================================

/**
 * An extension's runtime state in one conversation: `disabled`, `activating`
 * while it loads and activates, `active`, `deactivating` while its
 * contributions are removed, or `failed` to load or activate.
 */
export const ExtensionStateSchema = stringEnum(["disabled", "activating", "active", "deactivating", "failed"]);
export type ExtensionState = Static<typeof ExtensionStateSchema>;

/** Where an extension was found: the user's extensions, the project's, or a path given for one run. */
export const ExtensionSourceScopeSchema = stringEnum(["user", "project", "temporary"]);
export type ExtensionSourceScope = Static<typeof ExtensionSourceScopeSchema>;

/** One extension as the `extensions` query lists it. */
export const ExtensionSummarySchema = Type.Object(
	{
		id: ExtensionIdSchema,
		displayName: ExtensionDisplayNameSchema,
		description: Type.Optional(ExtensionDescriptionSchema),
		/** The package version; `local` for a single-file extension. */
		version: Type.String({ minLength: 1, maxLength: 256, pattern: UI_NODE_LINE_PATTERN }),
		scope: ExtensionSourceScopeSchema,
		/** Whether settings enable it; `state` says what it does now. */
		enabled: Type.Boolean(),
		state: ExtensionStateSchema,
		permissions: ExtensionPermissionsSchema,
		/** Whether the user acknowledged its current permissions. */
		permissionsAcknowledged: Type.Boolean(),
		/** Whether it declares settings the `extension_settings` query returns. */
		hasSettings: Type.Boolean(),
		/** Why it failed, when `state` is `failed`. */
		error: Type.Optional(Type.String({ maxLength: EXTENSION_ERROR_MAX_CHARS, pattern: UI_NODE_TEXT_PATTERN })),
		/**
		 * Where its code came from and which revision (an npm or git package, or
		 * a local path), as its permission acknowledgment records it; local
		 * clients only.
		 */
		fingerprint: Type.Optional(Type.String()),
	},
	closed,
);
export type ExtensionSummary = Static<typeof ExtensionSummarySchema>;

/**
 * An extension's settings editor: the form's fields (each `value` the
 * setting's default) and the values stored in each scope. Effective values
 * are the defaults, then global, then project values.
 */
export const ExtensionSettingsViewSchema = Type.Object(
	{
		form: Type.Array(UiNodeFormFieldSchema),
		values: Type.Object(
			{ global: ExtensionSettingsValuesSchema, project: Type.Optional(ExtensionSettingsValuesSchema) },
			closed,
		),
		/** Whether the project is trusted, so project values apply and may be written. */
		projectTrusted: Type.Boolean(),
	},
	closed,
);
export type ExtensionSettingsView = Static<typeof ExtensionSettingsViewSchema>;
