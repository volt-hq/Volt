/**
 * Extension settings (RFC §8.2): the settings a manifest declares, checked
 * and rendered as a form, and the values stored for them.
 *
 * A manifest declares a flat object of string, string enum, boolean, and
 * integer settings. TypeBox output is accepted as written: a union of string
 * literals (`anyOf`/`const`) and an `enum` without a `type` are read as a
 * string enum. Beyond the schema, each default must be a valid value, bounds
 * must be ordered, a pattern must be cheap to test (`isSafeFormPattern`), a
 * required setting must be declared, and a string setting must not look like
 * a credential: settings are plain JSON in settings.json, and a project's
 * settings are often committed.
 *
 * Values live under `extensions.<id>.settings` in global and, for trusted
 * projects, project settings. The effective values are the defaults, then the
 * global values, then the project values. A stored value that is not declared
 * or not valid is dropped with a diagnostic; one extension's values in one
 * scope hold at most 16 KB as JSON.
 */

import {
	EXTENSION_SETTING_NAME_PATTERN,
	EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES,
	type ExtensionSetting,
	type ExtensionSettings,
	type ExtensionSettingsScope,
	type ExtensionSettingsValues,
	type ExtensionSettingsView,
	UI_NODE_LINE_PATTERN,
	type UiNodeFormField,
} from "@hansjm10/volt-protocol";
import { FORM_PATTERN_VALUE_MAX_CHARS, isSafeFormPattern } from "../host/live-state.ts";
import type { SettingsManager } from "../settings-manager.ts";

/** Most settings one extension declares. */
export const EXTENSION_SETTINGS_MAX_PROPERTIES = 64;
/** Longest enum option, in characters. */
const ENUM_OPTION_MAX_CHARS = 256;

/** A setting value: a string, a boolean, or an integer. */
export type ExtensionSettingValue = string | boolean | number;

const NAME = new RegExp(EXTENSION_SETTING_NAME_PATTERN);
const LINE = new RegExp(UI_NODE_LINE_PATTERN, "u");

/** Settings or setting values that are not valid; the message names each problem. */
export class ExtensionSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExtensionSettingsError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** The own enumerable properties of `value`: TypeBox's non-enumerable markers are left behind. */
function ownEnumerable(value: Record<string, unknown>): Record<string, unknown> {
	const copy: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) defineOwn(copy, key, child);
	return copy;
}

/** The strings a union of string literals (`anyOf` of `{const}`) allows, or undefined when it is not one. */
function literalUnion(anyOf: unknown): string[] | undefined {
	if (!Array.isArray(anyOf) || anyOf.length === 0) return undefined;
	const literals: string[] = [];
	for (const member of anyOf) {
		if (!isRecord(member) || typeof member.const !== "string") return undefined;
		if (member.type !== undefined && member.type !== "string") return undefined;
		literals.push(member.const);
	}
	return literals;
}

function normalizeSetting(setting: unknown): unknown {
	if (!isRecord(setting)) return setting;
	const normalized = ownEnumerable(setting);
	const literals = literalUnion(normalized.anyOf);
	if (literals !== undefined && normalized.type === undefined) {
		delete normalized.anyOf;
		normalized.type = "string";
		normalized.enum = literals;
	} else if (typeof normalized.const === "string" && (normalized.type === undefined || normalized.type === "string")) {
		normalized.enum = [normalized.const];
		normalized.type = "string";
		delete normalized.const;
	} else if (
		normalized.type === undefined &&
		Array.isArray(normalized.enum) &&
		normalized.enum.every((value) => typeof value === "string")
	) {
		normalized.type = "string";
	}
	return normalized;
}

/**
 * A manifest's `settings` as the protocol schema reads it: TypeBox output
 * keeps only its own enumerable properties, and string literal unions and
 * untyped string enums become `{type: "string", enum}`. Anything else is
 * returned for the schema to judge.
 */
export function normalizeSettingsSchema(settings: unknown): unknown {
	if (!isRecord(settings)) return settings;
	const schema = ownEnumerable(settings);
	if (isRecord(schema.properties)) {
		const properties: Record<string, unknown> = {};
		for (const [name, setting] of Object.entries(schema.properties)) {
			defineOwn(properties, name, normalizeSetting(setting));
		}
		schema.properties = properties;
	}
	return schema;
}

const CREDENTIAL_WORDS: ReadonlySet<string> = new Set([
	"secret",
	"secrets",
	"password",
	"passwd",
	"passphrase",
	"pwd",
	"token",
	"credential",
	"credentials",
	"apikey",
	"privatekey",
	"accesskey",
	"bearer",
	"cookie",
	"cookies",
]);
const CREDENTIAL_PAIRS: ReadonlySet<string> = new Set([
	"api key",
	"private key",
	"access key",
	"secret key",
	"client secret",
]);
/** A word ending in one of these names a credential: `githubtoken`, `dbpassword`. */
const CREDENTIAL_SUFFIX = /(?:token|password|passwd|secret|apikey|privatekey|accesskey)$/;

/** Whether a setting name reads as a credential: `apiKey`, `github_token`, `clientSecret`, `password2`. */
export function namesCredential(name: string): boolean {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
		.split(/[\s_]+/)
		.map((word) => word.toLowerCase().replace(/\d+$/, ""))
		.filter((word) => word.length > 0);
	return words.some(
		(word, index) =>
			CREDENTIAL_WORDS.has(word) ||
			CREDENTIAL_SUFFIX.test(word) ||
			(index > 0 && CREDENTIAL_PAIRS.has(`${words[index - 1]} ${word}`)) ||
			(index > 0 && CREDENTIAL_WORDS.has(`${words[index - 1]}${word}`)),
	);
}

function codePoints(value: string): number {
	return [...value].length;
}

/** Why `value` is not a valid value of `setting`, or undefined when it is. */
export function settingValueProblem(setting: ExtensionSetting, value: unknown): string | undefined {
	switch (setting.type) {
		case "string": {
			if (typeof value !== "string") return "must be a string";
			if (!LINE.test(value)) return "must be one line without control characters";
			if ("enum" in setting) {
				return setting.enum.includes(value)
					? undefined
					: `must be one of ${setting.enum.map((option) => JSON.stringify(option)).join(", ")}`;
			}
			const length = codePoints(value);
			if (setting.minLength !== undefined && length < setting.minLength) {
				return `must be at least ${setting.minLength} characters`;
			}
			if (setting.maxLength !== undefined && length > setting.maxLength) {
				return `must be at most ${setting.maxLength} characters`;
			}
			if (setting.pattern === undefined) return undefined;
			if (length > FORM_PATTERN_VALUE_MAX_CHARS) {
				return `must be at most ${FORM_PATTERN_VALUE_MAX_CHARS} characters to match its pattern`;
			}
			return new RegExp(`^(?:${setting.pattern})$`, "u").test(value) ? undefined : "must match its pattern";
		}
		case "boolean":
			return typeof value === "boolean" ? undefined : "must be true or false";
		case "integer": {
			if (typeof value !== "number" || !Number.isSafeInteger(value)) return "must be an integer";
			if (setting.minimum !== undefined && value < setting.minimum) return `must be at least ${setting.minimum}`;
			if (setting.maximum !== undefined && value > setting.maximum) return `must be at most ${setting.maximum}`;
			return undefined;
		}
	}
}

function serializedBytes(values: unknown): number {
	return Buffer.byteLength(JSON.stringify(values), "utf8");
}

/** The declared defaults, by name. */
export function settingsDefaults(settings: ExtensionSettings | undefined): ExtensionSettingsValues {
	const defaults: ExtensionSettingsValues = {};
	for (const [name, setting] of Object.entries(settings?.properties ?? {})) {
		if (setting.default !== undefined) defineOwn(defaults, name, setting.default);
	}
	return defaults;
}

/**
 * Check what the schema cannot: defaults are valid values, bounds are ordered,
 * patterns are cheap to test, required settings are declared, no string
 * setting names a credential, and the defaults fit the stored-values bound.
 * Throws an {@link ExtensionSettingsError} naming the first problem.
 */
export function checkSettingsSchema(settings: ExtensionSettings): void {
	const entries = Object.entries(settings.properties);
	if (entries.length > EXTENSION_SETTINGS_MAX_PROPERTIES) {
		throw new ExtensionSettingsError(`settings declares more than ${EXTENSION_SETTINGS_MAX_PROPERTIES} settings`);
	}
	for (const name of settings.required ?? []) {
		if (!Object.hasOwn(settings.properties, name)) {
			throw new ExtensionSettingsError(`settings.required names ${JSON.stringify(name)}, which is not declared`);
		}
	}
	for (const [name, setting] of entries) {
		const at = `settings.properties.${name}`;
		if (
			"enum" in setting &&
			setting.enum.some((option) => !LINE.test(option) || option.length > ENUM_OPTION_MAX_CHARS)
		) {
			throw new ExtensionSettingsError(
				`${at}.enum options must be one line of at most ${ENUM_OPTION_MAX_CHARS} characters without control characters`,
			);
		}
		if (setting.type === "string" && !("enum" in setting)) {
			if (namesCredential(name)) {
				throw new ExtensionSettingsError(
					`${at} names a credential: settings are stored as plain JSON, so keep credentials in the auth storage (the "secrets" permission)`,
				);
			}
			if (
				setting.minLength !== undefined &&
				setting.maxLength !== undefined &&
				setting.minLength > setting.maxLength
			) {
				throw new ExtensionSettingsError(`${at}.minLength is greater than its maxLength`);
			}
			if (setting.pattern !== undefined) {
				if (!isSafeFormPattern(setting.pattern)) {
					throw new ExtensionSettingsError(
						`${at}.pattern is not a pattern every client can test cheaply: no backreferences, lookarounds, nested or overlapping repetition`,
					);
				}
				if (setting.maxLength !== undefined && setting.maxLength > FORM_PATTERN_VALUE_MAX_CHARS) {
					throw new ExtensionSettingsError(
						`${at}.maxLength exceeds ${FORM_PATTERN_VALUE_MAX_CHARS}, the longest value a pattern is tested against`,
					);
				}
			}
		}
		if (setting.type === "integer") {
			for (const bound of ["minimum", "maximum", "default"] as const) {
				const value = setting[bound];
				if (value !== undefined && !Number.isSafeInteger(value)) {
					throw new ExtensionSettingsError(`${at}.${bound} is not a safe integer`);
				}
			}
			if (setting.minimum !== undefined && setting.maximum !== undefined && setting.minimum > setting.maximum) {
				throw new ExtensionSettingsError(`${at}.minimum is greater than its maximum`);
			}
		}
		if (setting.default !== undefined) {
			const problem = settingValueProblem(setting, setting.default);
			if (problem !== undefined) throw new ExtensionSettingsError(`${at}.default ${problem}`);
		}
	}
	if (serializedBytes(settingsDefaults(settings)) > EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES) {
		throw new ExtensionSettingsError(
			`settings defaults exceed ${EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES} bytes as JSON, the most one scope stores`,
		);
	}
}

/** A setting value that was stored but is not used, and why. */
export interface DroppedSetting {
	readonly name: string;
	readonly reason: string;
}

/**
 * The valid values among stored ones: undeclared and invalid values are
 * dropped and reported; a `null` (a cleared value in a settings profile) is
 * skipped. Values beyond the 16 KB bound are dropped as a whole.
 */
export function readStoredSettings(
	settings: ExtensionSettings | undefined,
	stored: unknown,
): { readonly values: ExtensionSettingsValues; readonly dropped: readonly DroppedSetting[] } {
	const values: ExtensionSettingsValues = {};
	const dropped: DroppedSetting[] = [];
	if (stored === undefined || stored === null) return { values, dropped };
	if (!isRecord(stored)) return { values, dropped: [{ name: "*", reason: "settings must be an object" }] };
	if (serializedBytes(stored) > EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES) {
		return {
			values,
			dropped: [{ name: "*", reason: `stored settings exceed ${EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES} bytes` }],
		};
	}
	const properties = settings?.properties ?? {};
	for (const [name, value] of Object.entries(stored)) {
		if (value === null) continue;
		if (!NAME.test(name) || !Object.hasOwn(properties, name)) {
			dropped.push({ name, reason: "is not a declared setting" });
			continue;
		}
		const problem = settingValueProblem(properties[name]!, value);
		if (problem !== undefined) {
			dropped.push({ name, reason: problem });
			continue;
		}
		defineOwn(values, name, value);
	}
	return { values, dropped };
}

/**
 * Check values to store: every name declared, every value valid, and at most
 * 16 KB as JSON. Throws an {@link ExtensionSettingsError} listing each problem.
 */
export function checkSettingsValues(
	settings: ExtensionSettings | undefined,
	values: Readonly<Record<string, unknown>>,
): ExtensionSettingsValues {
	const properties = settings?.properties ?? {};
	const checked: ExtensionSettingsValues = {};
	const problems: string[] = [];
	for (const [name, value] of Object.entries(values)) {
		if (!NAME.test(name) || !Object.hasOwn(properties, name)) {
			problems.push(`${JSON.stringify(name)} is not a declared setting`);
			continue;
		}
		const problem = settingValueProblem(properties[name]!, value);
		if (problem !== undefined) problems.push(`${JSON.stringify(name)} ${problem}`);
		else defineOwn(checked, name, value);
	}
	if (problems.length > 0) throw new ExtensionSettingsError(`Invalid settings: ${problems.join("; ")}`);
	if (serializedBytes(checked) > EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES) {
		throw new ExtensionSettingsError(`Settings exceed ${EXTENSION_SETTINGS_MAX_SERIALIZED_BYTES} bytes as JSON`);
	}
	return checked;
}

/** The effective values: the defaults, then the global values, then the project values; frozen. */
export function effectiveSettings(
	settings: ExtensionSettings | undefined,
	global: ExtensionSettingsValues,
	project: ExtensionSettingsValues | undefined,
): Readonly<ExtensionSettingsValues> {
	const effective = settingsDefaults(settings);
	for (const scope of [global, project ?? {}]) {
		for (const [name, value] of Object.entries(scope)) defineOwn(effective, name, value);
	}
	return Object.freeze(effective);
}

/** The settings as form fields, each `value` its default, in declaration order. */
export function settingsFormFields(settings: ExtensionSettings | undefined): UiNodeFormField[] {
	const required = new Set(settings?.required ?? []);
	return Object.entries(settings?.properties ?? {}).map(([name, setting]) =>
		settingFormField(name, setting, required.has(name)),
	);
}

function settingFormField(name: string, setting: ExtensionSetting, required: boolean): UiNodeFormField {
	const base = {
		id: name,
		label: setting.title ?? name,
		...(setting.description === undefined ? {} : { description: setting.description }),
	};
	const requiredField = required ? { required: true } : {};
	if (setting.type === "boolean") {
		return { ...base, kind: "boolean", ...(setting.default === undefined ? {} : { value: setting.default }) };
	}
	if (setting.type === "integer") {
		return {
			...base,
			kind: "integer",
			...(setting.default === undefined ? {} : { value: setting.default }),
			...requiredField,
			...(setting.minimum === undefined ? {} : { min: setting.minimum }),
			...(setting.maximum === undefined ? {} : { max: setting.maximum }),
		};
	}
	if ("enum" in setting) {
		return {
			...base,
			kind: "enum",
			options: setting.enum.map((value) => ({ value })),
			...(setting.default === undefined ? {} : { value: setting.default }),
			...requiredField,
		};
	}
	return {
		...base,
		kind: "string",
		...(setting.default === undefined ? {} : { value: setting.default }),
		...requiredField,
		...(setting.minLength === undefined ? {} : { minLength: setting.minLength }),
		...(setting.maxLength === undefined ? {} : { maxLength: setting.maxLength }),
		...(setting.pattern === undefined ? {} : { pattern: setting.pattern }),
	};
}

/** One extension's stored values in a scope, read and checked, with what was dropped. */
export function storedSettings(
	manager: SettingsManager,
	id: string,
	settings: ExtensionSettings | undefined,
	scope: ExtensionSettingsScope,
): { readonly values: ExtensionSettingsValues; readonly dropped: readonly DroppedSetting[] } {
	return readStoredSettings(settings, manager.getExtensionSettings(id, scope));
}

/** An extension's settings editor: its form, the values stored in each scope, and whether the project is trusted. */
export function extensionSettingsView(
	manager: SettingsManager,
	id: string,
	settings: ExtensionSettings | undefined,
): ExtensionSettingsView {
	const projectTrusted = manager.isProjectTrusted();
	return {
		form: settingsFormFields(settings),
		values: {
			global: storedSettings(manager, id, settings, "global").values,
			...(projectTrusted ? { project: storedSettings(manager, id, settings, "project").values } : {}),
		},
		projectTrusted,
	};
}

/**
 * Store an extension's values in a scope, replacing what the scope held, once
 * they check out. A project write needs a trusted project. Resolves once the
 * write is durable.
 */
export async function storeExtensionSettings(
	manager: SettingsManager,
	id: string,
	settings: ExtensionSettings | undefined,
	scope: ExtensionSettingsScope,
	values: Readonly<Record<string, unknown>>,
): Promise<void> {
	if (scope === "project" && !manager.isProjectTrusted()) {
		throw new ExtensionSettingsError("Project settings are stored only for a trusted project");
	}
	const checked = checkSettingsValues(settings, values);
	manager.setExtensionSettings(id, scope, Object.keys(checked).length === 0 ? undefined : checked);
	await manager.flush();
}

/** An extension whose settings the runtime serves: its id and declared settings. */
export interface SettingsOwner {
	readonly id: string;
	readonly manifest: { readonly settings?: ExtensionSettings };
}

/** One extension's settings changing, as `settings_changed` reports it. */
export interface ExtensionSettingsChange {
	readonly id: string;
	readonly settings: Readonly<ExtensionSettingsValues>;
	readonly previous: Readonly<ExtensionSettingsValues>;
	readonly scope: ExtensionSettingsScope;
}

interface SettingsSnapshot {
	readonly revision: number;
	readonly global: string;
	readonly project: string;
	readonly effective: Readonly<ExtensionSettingsValues>;
}

const DEFAULTS_ONLY_REVISION = -1;

/**
 * The settings of one extension runtime's extensions: `volt.settings` reads
 * them, `volt.updateSettings` writes them, and `changes` reports what moved
 * since it last looked. Bound to the settings manager of the session that
 * loads or runs the extensions; unbound, each extension sees its defaults and
 * cannot write.
 */
export class ExtensionSettingsRuntime {
	private manager: SettingsManager | undefined;
	private readonly cache = new Map<string, SettingsSnapshot>();
	private readonly reported = new Map<string, SettingsSnapshot>();
	private readonly dropped = new Map<string, string>();

	constructor(manager?: SettingsManager) {
		this.manager = manager;
	}

	/** Read and write through `manager` from now on. */
	bind(manager: SettingsManager): void {
		if (this.manager === manager) return;
		this.manager = manager;
		this.cache.clear();
	}

	private snapshot(owner: SettingsOwner): SettingsSnapshot {
		const manager = this.manager;
		const settings = owner.manifest.settings;
		if (manager === undefined) {
			return {
				revision: DEFAULTS_ONLY_REVISION,
				global: "{}",
				project: "{}",
				effective: effectiveSettings(settings, {}, undefined),
			};
		}
		const revision = manager.getExtensionSettingsRevision();
		const cached = this.cache.get(owner.id);
		if (cached?.revision === revision) return cached;
		const global = storedSettings(manager, owner.id, settings, "global");
		const project = manager.isProjectTrusted() ? storedSettings(manager, owner.id, settings, "project") : undefined;
		const dropped = [...global.dropped, ...(project?.dropped ?? [])];
		if (dropped.length > 0) {
			this.dropped.set(owner.id, dropped.map((entry) => `${JSON.stringify(entry.name)} ${entry.reason}`).join("; "));
		}
		const snapshot: SettingsSnapshot = {
			revision,
			global: JSON.stringify(global.values),
			project: JSON.stringify(project?.values ?? {}),
			effective: effectiveSettings(settings, global.values, project?.values),
		};
		this.cache.set(owner.id, snapshot);
		return snapshot;
	}

	/** Whether settings enable the extension `id`; every extension is enabled without settings. */
	enabled(id: string): boolean {
		return this.manager?.getExtensionEnabled(id) ?? true;
	}

	/** The effective settings of `owner`, frozen. */
	values(owner: SettingsOwner): Readonly<ExtensionSettingsValues> {
		const snapshot = this.snapshot(owner);
		if (!this.reported.has(owner.id)) this.reported.set(owner.id, snapshot);
		return snapshot.effective;
	}

	/**
	 * Merge `values` over what `scope` stores for `owner` (an `undefined` value
	 * clears a setting) and store the result. Resolves once it is durable.
	 */
	async update(
		owner: SettingsOwner,
		values: Readonly<Record<string, unknown>>,
		scope: ExtensionSettingsScope,
	): Promise<void> {
		const manager = this.manager;
		if (manager === undefined) throw new ExtensionSettingsError("Settings cannot be stored in this runtime");
		const next: Record<string, unknown> = {
			...storedSettings(manager, owner.id, owner.manifest.settings, scope).values,
		};
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined) delete next[name];
			else defineOwn(next, name, value);
		}
		await storeExtensionSettings(manager, owner.id, owner.manifest.settings, scope, next);
	}

	/**
	 * The extensions among `owners` whose effective settings changed since this
	 * runtime last reported or served them, with the values before and after
	 * and the scope that changed.
	 */
	changes(owners: readonly SettingsOwner[]): ExtensionSettingsChange[] {
		const changes: ExtensionSettingsChange[] = [];
		for (const owner of owners) {
			const next = this.snapshot(owner);
			const previous = this.reported.get(owner.id);
			this.reported.set(owner.id, next);
			if (previous === undefined || JSON.stringify(previous.effective) === JSON.stringify(next.effective)) continue;
			changes.push({
				id: owner.id,
				settings: next.effective,
				previous: previous.effective,
				scope: previous.project !== next.project && previous.global === next.global ? "project" : "global",
			});
		}
		return changes;
	}

	/** Stored values that were dropped since the last call, by extension id, and forget them. */
	drainDropped(): Array<{ readonly id: string; readonly message: string }> {
		const dropped = [...this.dropped].map(([id, message]) => ({ id, message }));
		this.dropped.clear();
		return dropped;
	}
}

/**
 * The settings `volt.settings` holds for a manifest: each declared setting's
 * value type, present when it has a default and optional otherwise; none for a
 * manifest without settings. Type a factory with
 * `ExtensionAPI<ExtensionSettingsOf<typeof manifest>>`.
 */
export type ExtensionSettingsOf<M> = M extends { readonly settings: { readonly properties: infer P } }
	? { readonly [K in keyof P as P[K] extends { readonly default: unknown } ? K : never]: SettingValueOf<P[K]> } & {
			readonly [K in keyof P as P[K] extends { readonly default: unknown } ? never : K]?: SettingValueOf<P[K]>;
		}
	: Readonly<Record<string, never>>;

type SettingValueOf<S> = S extends { readonly enum: readonly (infer E)[] }
	? E
	: S extends { readonly anyOf: readonly (infer U)[] }
		? U extends { readonly const: infer C }
			? C
			: never
		: S extends { readonly type: "string" }
			? string
			: S extends { readonly type: "boolean" }
				? boolean
				: S extends { readonly type: "integer" }
					? number
					: never;
