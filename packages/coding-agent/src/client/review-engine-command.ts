/**
 * `/review --engine <name>`: a review engine's own options as flags beside the review's. A client reads the
 * engines from the `review.engines` query, offers their names after `--engine`, and, once the line names one,
 * adds that engine's parameters to the command so they parse, complete, and show in the usage line like the
 * review's own. The host's `review` intent takes the engine's id and its options apart from the review's:
 * {@link reviewEngineInput} splits a parsed line that way.
 */

import type { ExtensionSetting, RpcReviewEngine } from "@hansjm10/volt-protocol";
import type {
	IntentCommand,
	IntentCommandField,
	IntentCommandFlag,
	IntentCommandInput,
	IntentCommandOption,
	IntentCommandValue,
} from "./intent-command.ts";

/** The built-in pipeline: the engine a review runs on when none is named. */
export const STANDARD_ENGINE_WORD = "standard";

/** `waveSize` as a flag: `wave-size`. */
function kebab(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/_/g, "-")
		.toLowerCase();
}

/**
 * What a command line says to choose `engine`: its name within its extension when no other engine has that name
 * (and it is not `standard`), else its full id.
 */
export function reviewEngineWord(engine: RpcReviewEngine, engines: readonly RpcReviewEngine[]): string {
	const shared = engines.some((other) => other.id !== engine.id && other.name === engine.name);
	return shared || engine.name === STANDARD_ENGINE_WORD ? engine.id : engine.name;
}

/** The engine a word chooses: `standard`, an engine by its word or its id, or undefined when none. */
export function findReviewEngine(
	word: string,
	engines: readonly RpcReviewEngine[],
): RpcReviewEngine | typeof STANDARD_ENGINE_WORD | undefined {
	if (word === STANDARD_ENGINE_WORD) return STANDARD_ENGINE_WORD;
	return engines.find((engine) => engine.id === word || reviewEngineWord(engine, engines) === word);
}

/** The words that choose an engine, for a message that says what the user may type. */
export function reviewEngineWords(engines: readonly RpcReviewEngine[]): string[] {
	return [STANDARD_ENGINE_WORD, ...engines.map((engine) => reviewEngineWord(engine, engines))];
}

/** `command` with the engines offered after `--engine`: `standard` and each engine, with what it costs. */
export function withReviewEngines(command: IntentCommand, engines: readonly RpcReviewEngine[]): IntentCommand {
	const field = command.fields.find((candidate) => candidate.name === "engine");
	if (field === undefined || field.kind !== "string") return command;
	const suggestions: IntentCommandOption[] = [
		{ value: STANDARD_ENGINE_WORD, description: "The built-in review (the default)" },
		...engines.map((engine) => ({
			value: reviewEngineWord(engine, engines),
			description: engine.cost === undefined ? engine.description : `${engine.description} ${engine.cost}`,
		})),
	];
	return replaceField(command, { ...field, suggestions });
}

function replaceField(command: IntentCommand, replacement: IntentCommandField): IntentCommand {
	const flags = new Map<string, IntentCommandFlag>();
	for (const [name, flag] of command.flags) {
		flags.set(name, flag.field.name === replacement.name ? { ...flag, field: replacement } : flag);
	}
	return {
		...command,
		fields: command.fields.map((field) => (field.name === replacement.name ? replacement : field)),
		flags,
	};
}

function parameterField(name: string, setting: ExtensionSetting): IntentCommandField {
	const base = {
		name,
		title: setting.title ?? name,
		...(setting.description === undefined ? {} : { description: setting.description }),
		...(setting.default === undefined ? {} : { default: setting.default }),
		inForm: false,
		list: false,
		bare: false,
	};
	if (setting.type === "boolean") return { ...base, kind: "boolean" };
	if (setting.type === "integer") {
		return {
			...base,
			kind: "integer",
			...(setting.minimum === undefined ? {} : { minimum: setting.minimum }),
			...(setting.maximum === undefined ? {} : { maximum: setting.maximum }),
		};
	}
	if ("enum" in setting) return { ...base, kind: "enum", options: setting.enum };
	return {
		...base,
		kind: "string",
		...(setting.minLength === undefined ? {} : { minLength: setting.minLength }),
		...(setting.maxLength === undefined ? {} : { maxLength: setting.maxLength }),
		...(setting.pattern === undefined ? {} : { pattern: setting.pattern }),
	};
}

/** The names of the parameters `engine` takes, in declaration order. */
export function reviewEngineParameterNames(engine: RpcReviewEngine): string[] {
	return Object.keys(engine.parameters?.properties ?? {});
}

/**
 * `command` with `engine`'s parameters as flags after the review's own, so a line that names the engine can use
 * them. A parameter named like a flag the command already has is left out: the host refuses such an engine, so
 * this only guards a client that is told of one.
 */
export function withReviewEngine(command: IntentCommand, engine: RpcReviewEngine): IntentCommand {
	const fields = [...command.fields];
	const flags = new Map(command.flags);
	for (const [name, setting] of Object.entries(engine.parameters?.properties ?? {})) {
		const flag = kebab(name);
		if (flags.has(flag)) continue;
		const field = parameterField(name, setting);
		fields.push(field);
		flags.set(flag, { field });
	}
	return { ...command, fields, flags };
}

/** A review start split the way the host's `review` intent takes it. */
export interface ReviewEngineStart {
	/** The review's own fields, with `engine` the engine's id (absent for `standard`). */
	readonly input: IntentCommandInput;
	/** The engine's options. */
	readonly engineParams?: Record<string, IntentCommandValue>;
}

/** A parsed line split into the review's fields and the engine's options. */
export function reviewEngineInput(
	input: IntentCommandInput,
	engine: RpcReviewEngine | typeof STANDARD_ENGINE_WORD | undefined,
): ReviewEngineStart {
	const { engine: _word, ...rest } = input;
	if (engine === undefined || engine === STANDARD_ENGINE_WORD) return { input: rest };
	const names = new Set(reviewEngineParameterNames(engine));
	const own: IntentCommandInput = {};
	const engineParams: Record<string, IntentCommandValue> = {};
	for (const [name, value] of Object.entries(rest)) {
		if (names.has(name)) engineParams[name] = value;
		else own[name] = value;
	}
	return {
		input: { ...own, engine: engine.id },
		...(Object.keys(engineParams).length === 0 ? {} : { engineParams }),
	};
}
