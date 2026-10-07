/**
 * An intent's input as a command line, read from the schema the host describes it with. A host marks an intent's
 * input schema with the `x-volt-command` keyword (`IntentCommandHints`): which enum property a leading word selects,
 * which properties are flags, and which of them an options form offers. This module turns that declaration, and the
 * `title`, `description`, and `default` annotations beside it, into everything a client needs for a slash command:
 * a parser, the usage line, the equivalent command line of an input, an options form, and completions.
 *
 * It is generic over any descriptor's `input`; nothing here knows what a review is. The declaration is advisory: a
 * client that does not use it sends typed input, and it never affects what the host accepts.
 */

import { INTENT_COMMAND_KEYWORD, type IntentCommandHints, type UiNodeFormField } from "@hansjm10/volt-protocol";

export type IntentCommandValue = string | boolean | number;

/** An intent's input as a command line fills it: only the properties the line names. */
export type IntentCommandInput = Record<string, IntentCommandValue>;

/** A declaration that does not fit the schema it annotates. */
export class IntentCommandHintsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IntentCommandHintsError";
	}
}

/** A property a command takes as a flag and an options form shows. */
export interface IntentCommandField {
	readonly name: string;
	readonly kind: "string" | "boolean" | "enum" | "integer";
	readonly title: string;
	readonly description?: string;
	readonly default?: IntentCommandValue;
	/** An enum's values. */
	readonly options?: readonly string[];
	/** A string that holds a comma-separated list. */
	readonly list: boolean;
	/** An enum set by a bare flag per value (`--full`), not `--name value`. */
	readonly bare: boolean;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly pattern?: string;
}

/** A flag: a field, and for a bare flag the enum value it sets. */
export interface IntentCommandFlag {
	readonly field: IntentCommandField;
	readonly value?: string;
}

/** The leading word that selects an enum property. */
export interface IntentCommandKeyword {
	readonly field: string;
	readonly title: string;
	/** The enum values, in order. */
	readonly values: readonly string[];
	/** Every word that selects a value: its kebab-case, as spelled, and its aliases. */
	readonly words: ReadonlyMap<string, string>;
	/** The property the word after the keyword sets, by enum value. */
	readonly positional: ReadonlyMap<string, string>;
}

/** A leading word the client handles itself, such as a subcommand: parsing reports it and nothing else. */
export interface IntentCommandLocalKeyword {
	readonly word: string;
	readonly description?: string;
}

/** A command, read from an intent's input schema. */
export interface IntentCommand {
	/** The slash name, without the slash. */
	readonly name: string;
	readonly keyword?: IntentCommandKeyword;
	/** The fields the command takes, in the declared order. */
	readonly fields: readonly IntentCommandField[];
	/** Every flag, by name without the dashes. */
	readonly flags: ReadonlyMap<string, IntentCommandFlag>;
	readonly localKeywords: readonly IntentCommandLocalKeyword[];
}

export interface ParsedIntentCommand {
	/** The input the text fills; absent for empty text, a local keyword, or an error. */
	readonly input?: IntentCommandInput;
	/** A local keyword the text is. */
	readonly local?: string;
	readonly error?: string;
}

export interface IntentCommandCompletion {
	/** The whole argument text this completion leaves. */
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

/** A value the host offers for a property: `intent_completions`. */
export interface IntentCommandOption {
	readonly value: string;
	readonly label?: string;
	readonly description?: string;
}

/** The host's completions for a property, by prefix. */
export type IntentCommandFieldCompleter = (field: string, prefix: string) => Promise<readonly IntentCommandOption[]>;

// ============================================================================
// Reading the declaration
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `branchUncommitted` and `branch_uncommitted` as a word or a flag: `branch-uncommitted`. */
function kebab(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
}

function stringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new IntentCommandHintsError(`${label} must be a list of property names`);
	}
	return value as string[];
}

interface Property {
	readonly kind: IntentCommandField["kind"];
	readonly record: Record<string, unknown>;
	readonly options?: readonly string[];
}

function propertyOf(properties: Record<string, unknown>, name: string, label: string): Property {
	const record = properties[name];
	if (!isRecord(record)) throw new IntentCommandHintsError(`${label}: "${name}" is not a property of the input`);
	if (Array.isArray(record.enum)) {
		if (!record.enum.every((entry) => typeof entry === "string") || record.enum.length === 0) {
			throw new IntentCommandHintsError(`${label}: "${name}" is an enum of something other than strings`);
		}
		return { kind: "enum", record, options: record.enum as string[] };
	}
	if (record.type === "string") return { kind: "string", record };
	if (record.type === "boolean") return { kind: "boolean", record };
	if (record.type === "integer") return { kind: "integer", record };
	throw new IntentCommandHintsError(`${label}: "${name}" is not a string, boolean, integer, or string enum`);
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === "string" ? record[key] : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	return typeof record[key] === "number" ? record[key] : undefined;
}

function defaultOf(name: string, property: Property): IntentCommandValue | undefined {
	const value = property.record.default;
	if (value === undefined) return undefined;
	const fits =
		(property.kind === "enum" && typeof value === "string" && property.options?.includes(value) === true) ||
		(property.kind === "string" && typeof value === "string") ||
		(property.kind === "boolean" && typeof value === "boolean") ||
		(property.kind === "integer" && typeof value === "number" && Number.isInteger(value));
	if (!fits) throw new IntentCommandHintsError(`The default of "${name}" does not fit its type`);
	return value as IntentCommandValue;
}

/**
 * Read an intent's command declaration from its descriptor's `input` schema, or undefined when it declares none.
 * Throws {@link IntentCommandHintsError} for a declaration that does not fit the schema, so a mismatch shows as
 * itself and not as a command that parses oddly. `localKeywords` are words the client handles itself.
 */
export function readCommandHints(
	input: Record<string, unknown>,
	options: { readonly name: string; readonly localKeywords?: readonly IntentCommandLocalKeyword[] },
): IntentCommand | undefined {
	const hints = input[INTENT_COMMAND_KEYWORD];
	if (hints === undefined) return undefined;
	if (!isRecord(hints)) throw new IntentCommandHintsError(`${INTENT_COMMAND_KEYWORD} must be an object`);
	const declared = hints as IntentCommandHints & Record<string, unknown>;
	const properties = isRecord(input.properties) ? input.properties : {};

	const formNames = stringList(declared.form ?? [], "form");
	const listNames = new Set(stringList(declared.lists ?? [], "lists"));
	const bareNames = new Set(stringList(declared.flagValues ?? [], "flagValues"));
	if (new Set(formNames).size !== formNames.length) throw new IntentCommandHintsError("form names a property twice");

	let keyword: IntentCommandKeyword | undefined;
	if (declared.keyword !== undefined) {
		const declaredKeyword: unknown = declared.keyword;
		if (!isRecord(declaredKeyword) || typeof declaredKeyword.field !== "string") {
			throw new IntentCommandHintsError("keyword needs a field");
		}
		const field = declaredKeyword.field;
		const property = propertyOf(properties, field, "keyword");
		if (property.kind !== "enum" || property.options === undefined) {
			throw new IntentCommandHintsError(`keyword: "${field}" must be a string enum`);
		}
		const values = property.options;
		const words = new Map<string, string>();
		const addWord = (word: string, value: string): void => {
			const known = words.get(word);
			if (known !== undefined && known !== value) {
				throw new IntentCommandHintsError(`keyword: the word "${word}" selects both "${known}" and "${value}"`);
			}
			words.set(word, value);
		};
		for (const value of values) {
			addWord(kebab(value), value);
			addWord(value.toLowerCase(), value);
		}
		for (const [word, value] of Object.entries(declaredKeyword.aliases ?? {})) {
			if (typeof value !== "string" || !values.includes(value)) {
				throw new IntentCommandHintsError(`keyword: the alias "${word}" does not name a value of "${field}"`);
			}
			addWord(word.toLowerCase(), value);
		}
		const positional = new Map<string, string>();
		for (const [value, target] of Object.entries(declaredKeyword.positional ?? {})) {
			if (!values.includes(value)) {
				throw new IntentCommandHintsError(`keyword: "${value}" is not a value of "${field}"`);
			}
			if (typeof target !== "string" || propertyOf(properties, target, "keyword").kind !== "string") {
				throw new IntentCommandHintsError(`keyword: the word after "${value}" must set a string property`);
			}
			positional.set(value, target);
		}
		keyword = { field, title: optionalString(property.record, "title") ?? field, values, words, positional };
	}

	const fields: IntentCommandField[] = [];
	for (const name of formNames) {
		if (name === keyword?.field) throw new IntentCommandHintsError(`form: "${name}" is the keyword's property`);
		const property = propertyOf(properties, name, "form");
		const list = listNames.has(name);
		const bare = bareNames.has(name);
		if (list && property.kind !== "string") throw new IntentCommandHintsError(`lists: "${name}" must be a string`);
		if (bare && property.kind !== "enum") throw new IntentCommandHintsError(`flagValues: "${name}" must be an enum`);
		const description = optionalString(property.record, "description");
		const fallback = defaultOf(name, property);
		const minimum = optionalNumber(property.record, "minimum");
		const maximum = optionalNumber(property.record, "maximum");
		const minLength = optionalNumber(property.record, "minLength");
		const maxLength = optionalNumber(property.record, "maxLength");
		const pattern = optionalString(property.record, "pattern");
		fields.push({
			name,
			kind: property.kind,
			title: optionalString(property.record, "title") ?? name,
			...(description === undefined ? {} : { description }),
			...(fallback === undefined ? {} : { default: fallback }),
			...(property.options === undefined ? {} : { options: property.options }),
			list,
			bare,
			...(minimum === undefined ? {} : { minimum }),
			...(maximum === undefined ? {} : { maximum }),
			...(minLength === undefined ? {} : { minLength }),
			...(maxLength === undefined ? {} : { maxLength }),
			...(pattern === undefined ? {} : { pattern }),
		});
	}
	for (const name of [...listNames, ...bareNames]) {
		if (!formNames.includes(name)) throw new IntentCommandHintsError(`"${name}" is a flag but not in form`);
	}

	const flags = new Map<string, IntentCommandFlag>();
	const addFlag = (name: string, flag: IntentCommandFlag): void => {
		if (flags.has(name)) throw new IntentCommandHintsError(`Two flags are named --${name}`);
		flags.set(name, flag);
	};
	for (const field of fields) {
		if (field.bare) for (const value of field.options ?? []) addFlag(kebab(value), { field, value });
		else addFlag(kebab(field.name), { field });
	}
	return {
		name: options.name,
		...(keyword === undefined ? {} : { keyword }),
		fields,
		flags,
		localKeywords: options.localKeywords ?? [],
	};
}

// ============================================================================
// Tokens
// ============================================================================

/** Split command text into words: whitespace separates, quotes group, and a backslash escapes only inside quotes. */
function tokenize(text: string): { tokens: string[]; error?: string } {
	const tokens: string[] = [];
	let token = "";
	let quote: '"' | "'" | undefined;
	let escaping = false;
	const push = (): void => {
		if (token) tokens.push(token);
		token = "";
	};
	for (const character of text.trim()) {
		if (escaping) {
			token += character;
			escaping = false;
			continue;
		}
		if (character === "\\" && quote) {
			escaping = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else token += character;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) push();
		else token += character;
	}
	if (escaping || quote) return { tokens, error: "Unterminated quoted argument." };
	push();
	return { tokens };
}

/** A word as command text: bare when that reads back the same, else quoted. */
function quoteWord(value: string): string {
	return /^[^\s"'\\]+$/.test(value) ? value : `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function orList(values: readonly string[]): string {
	if (values.length <= 2) return values.join(" or ");
	return `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
}

/** A list property's entries: split on commas and newlines, trimmed, without repeats. */
function listEntries(value: string): string[] {
	return [
		...new Set(
			value
				.split(/[\n,]/)
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
}

// ============================================================================
// Usage and the equivalent command
// ============================================================================

function keywordPhrase(command: IntentCommand, value: string): string {
	const positional = command.keyword?.positional.get(value);
	return positional === undefined ? kebab(value) : `${kebab(value)} [${positional}]`;
}

/** The keywords with their positional words: `uncommitted | branch [base] | pr [number]`; the slash menu's hint. */
export function intentCommandExample(command: IntentCommand): string {
	const phrases = (command.keyword?.values ?? []).map((value) => keywordPhrase(command, value));
	return `/${command.name}${phrases.length === 0 ? "" : ` ${phrases.join(" | ")}`}`;
}

function flagUsage(field: IntentCommandField): string {
	if (field.bare) return `[${(field.options ?? []).map((value) => `--${kebab(value)}`).join("|")}]`;
	const flag = `--${kebab(field.name)}`;
	if (field.kind === "boolean") return `[${flag}]`;
	if (field.kind === "enum") return `[${flag} ${(field.options ?? []).join("|")}]`;
	return `[${flag} <${field.kind === "integer" ? "n" : field.name}>]`;
}

/** The full usage line, appended to every parse error. */
export function intentCommandUsage(command: IntentCommand): string {
	const keywords = [
		...command.localKeywords.map((local) => local.word),
		...(command.keyword?.values ?? []).map((value) => keywordPhrase(command, value)),
	];
	const parts = [
		`Usage: /${command.name}`,
		...(keywords.length === 0 ? [] : [`[${keywords.join(" | ")}]`]),
		...command.fields.map(flagUsage),
	];
	return parts.join(" ");
}

/** The command text of `input`: what to type for the same review. Properties the command has no flag for are left out. */
export function formatIntentCommand(command: IntentCommand, input: Readonly<Record<string, unknown>>): string {
	const words: string[] = [];
	const keyword = command.keyword;
	const selected = keyword === undefined ? undefined : input[keyword.field];
	if (keyword !== undefined && typeof selected === "string") {
		words.push(kebab(selected));
		const positional = keyword.positional.get(selected);
		const given = positional === undefined ? undefined : input[positional];
		if (typeof given === "string" && given !== "") words.push(quoteWord(given));
	}
	for (const field of command.fields) {
		const value = input[field.name];
		if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") continue;
		if (value === "" || value === (field.default ?? (field.kind === "boolean" ? false : undefined))) continue;
		const flag = `--${kebab(field.name)}`;
		if (field.bare) {
			words.push(`--${kebab(String(value))}`);
		} else if (field.kind === "boolean") {
			words.push(value === true ? flag : `${flag}=false`);
		} else {
			const text = field.list && typeof value === "string" ? listEntries(value).join(",") : String(value);
			if (text === "") continue;
			// A value that reads as a flag can only follow `=`.
			words.push(text.startsWith("--") ? `${flag}=${quoteWord(text)}` : `${flag} ${quoteWord(text)}`);
		}
	}
	return words.join(" ");
}

// ============================================================================
// Parsing
// ============================================================================

function failure(command: IntentCommand, message: string): ParsedIntentCommand {
	return { error: `${message} ${intentCommandUsage(command)}` };
}

/**
 * Parse command text into the input it fills. Empty text gives `{}`; a local keyword gives `{local}`. The first word
 * selects the keyword's value (a word after it may set that value's positional property), and the rest are flags:
 * `--name value`, `--name=value`, a bare `--flag` for a boolean or an enum value, a repeatable `--flag` for a list.
 * Properties the text does not name are left out, so the host applies its defaults.
 */
export function parseIntentCommand(command: IntentCommand, text: string): ParsedIntentCommand {
	const tokenized = tokenize(text);
	if (tokenized.error !== undefined) return failure(command, tokenized.error);
	const tokens = tokenized.tokens;
	if (tokens.length === 0) return {};
	const input: IntentCommandInput = {};
	let index = 0;
	const keyword = command.keyword;
	if (keyword !== undefined) {
		const first = tokens[0] as string;
		const word = first.toLowerCase();
		const local = command.localKeywords.find((candidate) => candidate.word === word);
		if (local !== undefined) {
			return tokens.length === 1
				? { local: local.word }
				: failure(command, `Unexpected arguments after "${local.word}".`);
		}
		const value = keyword.words.get(word);
		if (value === undefined) return failure(command, `Unknown ${keyword.title.toLowerCase()} "${first}".`);
		input[keyword.field] = value;
		index = 1;
		const positional = keyword.positional.get(value);
		const next = tokens[index];
		if (positional !== undefined && next !== undefined && !next.startsWith("--")) {
			input[positional] = next;
			index++;
		}
	}

	const lists = new Map<string, Set<string>>();
	while (index < tokens.length) {
		const token = tokens[index++] as string;
		const flag = token.startsWith("--") ? command.flags.get(token.slice(2).split("=")[0] as string) : undefined;
		if (flag === undefined) return failure(command, `Unknown or misplaced argument "${token}".`);
		const equals = token.indexOf("=");
		const name = token.slice(2, equals === -1 ? undefined : equals);
		const inline = equals === -1 ? undefined : token.slice(equals + 1);
		const { field } = flag;
		if (flag.value !== undefined) {
			if (inline !== undefined) return failure(command, `--${name} takes no value.`);
			input[field.name] = flag.value;
			continue;
		}
		if (field.kind === "boolean") {
			if (inline !== undefined && inline !== "true" && inline !== "false") {
				return failure(command, `--${name} takes no value, or true or false.`);
			}
			input[field.name] = inline !== "false";
			continue;
		}
		const value = inline ?? tokens[index++];
		if (field.kind === "enum") {
			const options = field.options ?? [];
			if (value === undefined || !options.includes(value)) {
				return failure(command, `--${name} must be ${orList(options)}.`);
			}
			input[field.name] = value;
			continue;
		}
		if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
			return failure(command, `--${name} needs a value.`);
		}
		if (field.kind === "integer") {
			const number = Number(value);
			const low = field.minimum ?? Number.MIN_SAFE_INTEGER;
			const high = field.maximum ?? Number.MAX_SAFE_INTEGER;
			if (!/^-?\d+$/.test(value) || number < low || number > high) {
				return failure(command, `--${name} must be an integer from ${low} to ${high}.`);
			}
			input[field.name] = number;
		} else if (field.list) {
			const entries = lists.get(field.name) ?? new Set<string>();
			for (const entry of listEntries(value)) entries.add(entry);
			lists.set(field.name, entries);
		} else {
			input[field.name] = value;
		}
	}
	for (const [name, entries] of lists) if (entries.size > 0) input[name] = [...entries].join(",");
	return { input };
}

// ============================================================================
// The options form
// ============================================================================

/** The options form: one field per declared flag, in order, each with its default. */
export function intentCommandForm(command: IntentCommand): UiNodeFormField[] {
	return command.fields.map((field): UiNodeFormField => {
		const base = {
			id: field.name,
			label: field.title,
			...(field.description === undefined ? {} : { description: field.description }),
		};
		if (field.kind === "boolean") {
			return { ...base, kind: "boolean", ...(typeof field.default === "boolean" ? { value: field.default } : {}) };
		}
		if (field.kind === "integer") {
			return {
				...base,
				kind: "integer",
				...(typeof field.default === "number" ? { value: field.default } : {}),
				...(field.minimum === undefined ? {} : { min: field.minimum }),
				...(field.maximum === undefined ? {} : { max: field.maximum }),
			};
		}
		if (field.kind === "enum") {
			return {
				...base,
				kind: "enum",
				options: (field.options ?? []).map((value) => ({ value })),
				...(typeof field.default === "string" ? { value: field.default } : {}),
			};
		}
		return {
			...base,
			kind: "string",
			...(typeof field.default === "string" ? { value: field.default } : {}),
			...(field.minLength === undefined ? {} : { minLength: field.minLength }),
			...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
			...(field.pattern === undefined ? {} : { pattern: field.pattern }),
		};
	});
}

/** The input a submitted options form fills: only what is set and differs from the default. */
export function intentCommandFormInput(
	command: IntentCommand,
	values: Readonly<Record<string, IntentCommandValue>>,
): IntentCommandInput {
	const input: IntentCommandInput = {};
	for (const field of command.fields) {
		const given = values[field.name];
		if (given === undefined || given === "") continue;
		const value = field.list && typeof given === "string" ? listEntries(given).join(",") : given;
		if (value === "" || value === (field.default ?? (field.kind === "boolean" ? false : undefined))) continue;
		input[field.name] = value;
	}
	return input;
}

// ============================================================================
// Completion
// ============================================================================

/** Where the word being typed starts, or undefined inside an open quote. */
function currentWordStart(text: string): number | undefined {
	let quote: string | undefined;
	let escaping = false;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index] as string;
		if (escaping) {
			escaping = false;
		} else if (character === "\\" && quote) {
			escaping = true;
		} else if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === '"' || character === "'") {
			quote = character;
		} else if (/\s/.test(character)) {
			start = index + 1;
		}
	}
	return quote === undefined ? start : undefined;
}

/**
 * Completions for the argument text typed so far, each the whole text it would leave: the keywords for the first
 * word; then the keyword's positional values (from the host, through `complete`) and the flags not yet used; and the
 * values of an enum flag. Free text, and anything inside quotes, has none.
 */
export async function completeIntentCommand(
	command: IntentCommand,
	text: string,
	complete: IntentCommandFieldCompleter,
): Promise<IntentCommandCompletion[]> {
	const start = currentWordStart(text);
	if (start === undefined) return [];
	const partial = text.slice(start);
	if (/["']/.test(partial)) return [];
	const head = text.slice(0, start);
	const words = tokenize(head).tokens;
	const item = (word: string, label: string, description?: string): IntentCommandCompletion => ({
		value: `${head}${word}`,
		label,
		...(description === undefined ? {} : { description }),
	});
	const keyword = command.keyword;

	if (words.length === 0) {
		if (keyword === undefined || partial.startsWith("--")) return [];
		const prefix = partial.toLowerCase();
		return [
			...command.localKeywords
				.filter((local) => local.word.startsWith(prefix))
				.map((local) => item(local.word, local.word, local.description)),
			...keyword.values
				.filter((value) => kebab(value).startsWith(prefix))
				.map((value) => item(kebab(value), kebab(value), keywordPhrase(command, value))),
		];
	}

	let index = 0;
	let positional: string | undefined;
	if (keyword !== undefined) {
		const value = keyword.words.get((words[0] as string).toLowerCase());
		if (value === undefined) return [];
		index = 1;
		positional = keyword.positional.get(value);
		const next = words[index];
		if (positional !== undefined && next !== undefined && !next.startsWith("--")) {
			positional = undefined;
			index++;
		}
	}
	const used = new Set<string>();
	let awaiting: IntentCommandField | undefined;
	for (; index < words.length; index++) {
		const word = words[index] as string;
		if (awaiting !== undefined) {
			used.add(awaiting.name);
			awaiting = undefined;
			continue;
		}
		const flag = word.startsWith("--") ? command.flags.get(word.slice(2).split("=")[0] as string) : undefined;
		if (flag === undefined) continue;
		if (flag.value === undefined && flag.field.kind !== "boolean" && !word.includes("=")) awaiting = flag.field;
		else used.add(flag.field.name);
	}

	if (awaiting !== undefined) {
		return (awaiting.kind === "enum" ? (awaiting.options ?? []) : [])
			.filter((value) => value.startsWith(partial))
			.map((value) => item(value, value));
	}
	const completions: IntentCommandCompletion[] = [];
	if (positional !== undefined && !partial.startsWith("--")) {
		for (const option of await complete(positional, partial)) {
			completions.push(item(quoteWord(option.value), option.label ?? option.value, option.description));
		}
	}
	if (partial === "" || partial.startsWith("--")) {
		for (const [name, flag] of command.flags) {
			if (!`--${name}`.startsWith(partial)) continue;
			if (used.has(flag.field.name) && !flag.field.list) continue;
			completions.push(item(`--${name}`, `--${name}`, flag.field.description ?? flag.field.title));
		}
	}
	return completions;
}
