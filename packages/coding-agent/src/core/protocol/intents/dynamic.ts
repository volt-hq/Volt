/**
 * Dynamic intents: extension commands and intents, prompt templates, and
 * skills. An extension command is `extension.command.<manifest id>.<command
 * name>`; prompt templates and skills are `prompt.template.<id>` and
 * `skill.<id>` by opaque per-catalog ids. Invoking one of those sends its
 * slash text as a prompt. An extension intent is
 * `extension.intent.<manifest id>.<name>`: invoking it runs its handler with
 * input the host checked against the schema the extension registered; paired
 * remote devices invoke it only when the extension opted in.
 *
 * Descriptors never carry prompt bodies, skill content, raw source info, or
 * host paths: display strings are bounded and path-like text is redacted.
 */

import { randomBytes } from "node:crypto";
import type { IntentOption } from "@hansjm10/volt-protocol";
import type { RegisteredIntent, ResolvedCommand } from "../../extensions/types.ts";
import type { PromptTemplate } from "../../prompt-templates.ts";
import type { ResourceLoader } from "../../resource-loader.ts";
import type { Skill } from "../../skills.ts";
import type { SourceInfo } from "../../source-info.ts";
import type { IntentMetadata } from "./types.ts";

export const MAX_DYNAMIC_INTENTS = 200;
export const MAX_INTENT_COMPLETIONS = 50;
export const MAX_INTENT_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 240;
const MAX_SOURCE_LABEL_LENGTH = 80;
const MAX_HINT_LENGTH = 160;
const REDACTED_PATH = "[redacted path]";

/** The parts of a session the dynamic catalog reads. */
export interface DynamicIntentSource {
	extensionRunner: {
		getRegisteredCommands(): ResolvedCommand[];
		getRegisteredIntents(): RegisteredIntent[];
		getIntent(intent: string): RegisteredIntent | undefined;
	};
	promptTemplates: ReadonlyArray<PromptTemplate>;
	resourceLoader: Pick<ResourceLoader, "getSkills">;
}

/** One dynamic intent: its descriptor metadata and what invoking it prompts. */
export interface DynamicIntent extends IntentMetadata {
	readonly name: string;
	readonly source: "extension" | "prompt" | "skill";
	readonly sourceScope: SourceInfo["scope"];
	readonly sourceOrigin: SourceInfo["origin"];
	readonly sourceLabel?: string;
	/** The slash name the prompt invokes. */
	readonly promptName: string;
	/** Bounded argument hint (prompt templates). */
	readonly argumentHint?: string;
	readonly command?: ResolvedCommand;
}

/** An intent an extension registered, as the catalog describes it. */
export interface ExtensionIntent extends IntentMetadata {
	readonly name: string;
	readonly source: "extension";
	/** The extension's manifest id. */
	readonly sourceLabel: string;
	readonly registered: RegisteredIntent;
}

interface CatalogState {
	fingerprint: string;
	token: string;
}

const catalogStates = new WeakMap<DynamicIntentSource, CatalogState>();

/** The session's dynamic intents, extension commands first, at most {@link MAX_DYNAMIC_INTENTS}. */
export function listDynamicIntents(source: DynamicIntentSource): DynamicIntent[] {
	const token = getCatalogToken(source);
	const extensionIntents = source.extensionRunner.getRegisteredCommands().map(createExtensionCommandIntent);
	const promptIntents = source.promptTemplates.map((template, index) =>
		createPromptTemplateIntent(template, index, token),
	);
	const skillIntents = source.resourceLoader
		.getSkills()
		.skills.map((skill, index) => createSkillIntent(skill, index, token));
	return [...extensionIntents, ...promptIntents, ...skillIntents].slice(0, MAX_DYNAMIC_INTENTS);
}

export function findDynamicIntent(source: DynamicIntentSource, name: string): DynamicIntent | undefined {
	return listDynamicIntents(source).find((intent) => intent.name === name);
}

/** The intents the session's extensions registered, in load order. */
export function listExtensionIntents(source: DynamicIntentSource): ExtensionIntent[] {
	return source.extensionRunner.getRegisteredIntents().map(createExtensionIntent);
}

/** The extension intent named `name`, if an extension registered it. */
export function findExtensionIntent(source: DynamicIntentSource, name: string): ExtensionIntent | undefined {
	const registered = source.extensionRunner.getIntent(name);
	return registered === undefined ? undefined : createExtensionIntent(registered);
}

function createExtensionIntent(registered: RegisteredIntent): ExtensionIntent {
	return {
		name: registered.intent,
		label: boundedDisplayString(registered.label, MAX_INTENT_LABEL_LENGTH) ?? "Extension intent",
		description: boundedDisplayString(registered.description, MAX_DESCRIPTION_LENGTH),
		category: "extension",
		source: "extension",
		sourceLabel: registered.extensionId,
		scope: "conversation",
		fence: "none",
		remote: registered.remote ? "safe" : "unsafe",
		// Conversation control first: remote admission names the first capability a device lacks.
		requires: [...new Set(["conversation.control.v1" as const, ...registered.requires])],
		whileBusy: "run",
		presentation: { kind: "palette", group: "Extensions" },
		registered,
	};
}

/** The prompt a dynamic intent sends for its raw argument text. */
export function dynamicIntentPromptText(intent: DynamicIntent, rawArguments: string): string {
	return rawArguments.length > 0 ? `/${intent.promptName} ${rawArguments}` : `/${intent.promptName}`;
}

/** Completions for an extension command's arguments, bounded and redacted. */
export async function completeDynamicIntentArguments(intent: DynamicIntent, prefix: string): Promise<IntentOption[]> {
	if (!intent.command?.getArgumentCompletions) return [];
	const completions = await intent.command.getArgumentCompletions(prefix);
	return (completions ?? [])
		.map((completion) => ({
			value: boundedDisplayString(completion.value, MAX_INTENT_LABEL_LENGTH) ?? "",
			label: boundedDisplayString(completion.label, MAX_INTENT_LABEL_LENGTH),
			description: boundedDisplayString(completion.description, MAX_DESCRIPTION_LENGTH),
		}))
		.filter((completion) => completion.value.length > 0)
		.slice(0, MAX_INTENT_COMPLETIONS);
}

const dynamicIntentBase = {
	scope: "conversation",
	fence: "branch",
	requires: ["conversation.control.v1"],
} as const;

function createExtensionCommandIntent(command: ResolvedCommand): DynamicIntent {
	return {
		...dynamicIntentBase,
		...safeSourceFields(command.sourceInfo),
		// Both parts are validated: the manifest id and the command name. The intent is stable across reloads.
		name: `extension.command.${command.extensionId}.${command.name}`,
		label: boundedDisplayString(command.invocationName, MAX_INTENT_LABEL_LENGTH) ?? "Extension command",
		description: boundedDisplayString(command.description, MAX_DESCRIPTION_LENGTH),
		category: "extension",
		source: "extension",
		presentation: { kind: "palette", group: "Extensions" },
		slash: { name: command.invocationName, example: `/${command.invocationName}` },
		remote: command.remoteSafe === true ? "safe" : "unsafe",
		whileBusy: "run",
		...(command.getArgumentCompletions ? { completions: ["arguments"] } : {}),
		promptName: command.invocationName,
		command,
	};
}

function createPromptTemplateIntent(template: PromptTemplate, index: number, token: string): DynamicIntent {
	const argumentHint = boundedDisplayString(template.argumentHint, MAX_HINT_LENGTH);
	return {
		...dynamicIntentBase,
		...safeSourceFields(template.sourceInfo),
		name: `prompt.template.${opaqueId("pt", token, index)}`,
		label: boundedDisplayString(template.name, MAX_INTENT_LABEL_LENGTH) ?? "Prompt template",
		description: boundedDisplayString(template.description, MAX_DESCRIPTION_LENGTH),
		category: "prompt",
		source: "prompt",
		presentation: { kind: "palette", group: "Prompts" },
		slash: { name: template.name, example: `/${template.name}` },
		remote: "safe",
		whileBusy: "queue",
		promptName: template.name,
		...(argumentHint ? { argumentHint } : {}),
	};
}

function createSkillIntent(skill: Skill, index: number, token: string): DynamicIntent {
	return {
		...dynamicIntentBase,
		...safeSourceFields(skill.sourceInfo),
		name: `skill.${opaqueId("sk", token, index)}`,
		label: boundedDisplayString(skill.name, MAX_INTENT_LABEL_LENGTH) ?? "Skill",
		description: boundedDisplayString(skill.description, MAX_DESCRIPTION_LENGTH),
		category: "skill",
		source: "skill",
		presentation: { kind: "palette", group: "Skills" },
		slash: { name: `skill:${skill.name}`, example: `/skill:${skill.name}` },
		remote: "safe",
		whileBusy: "queue",
		promptName: `skill:${skill.name}`,
	};
}

function getCatalogToken(source: DynamicIntentSource): string {
	const fingerprint = getCatalogFingerprint(source);
	const existing = catalogStates.get(source);
	if (existing?.fingerprint === fingerprint) {
		return existing.token;
	}
	const next = {
		fingerprint,
		token: randomBytes(6).toString("hex"),
	};
	catalogStates.set(source, next);
	return next.token;
}

function getCatalogFingerprint(source: DynamicIntentSource): string {
	return JSON.stringify({
		prompts: source.promptTemplates.map((template) => ({
			argumentHint: template.argumentHint,
			content: template.content,
			description: template.description,
			filePath: template.filePath,
			name: template.name,
			sourceInfo: sourceFingerprint(template.sourceInfo),
		})),
		skills: source.resourceLoader.getSkills().skills.map((skill) => ({
			baseDir: skill.baseDir,
			description: skill.description,
			disableModelInvocation: skill.disableModelInvocation,
			filePath: skill.filePath,
			name: skill.name,
			sourceInfo: sourceFingerprint(skill.sourceInfo),
		})),
	});
}

function sourceFingerprint(sourceInfo: SourceInfo): Record<string, string | undefined> {
	return {
		baseDir: sourceInfo.baseDir,
		origin: sourceInfo.origin,
		path: sourceInfo.path,
		scope: sourceInfo.scope,
		source: sourceInfo.source,
	};
}

function safeSourceFields(sourceInfo: SourceInfo): Pick<DynamicIntent, "sourceScope" | "sourceOrigin" | "sourceLabel"> {
	const sourceLabel = boundedDisplayString(getSafeSourceLabel(sourceInfo), MAX_SOURCE_LABEL_LENGTH);
	return {
		sourceScope: sourceInfo.scope,
		sourceOrigin: sourceInfo.origin,
		...(sourceLabel === undefined ? {} : { sourceLabel }),
	};
}

function getSafeSourceLabel(sourceInfo: SourceInfo): string {
	if (sourceInfo.origin === "package") {
		return "Package";
	}

	switch (sourceInfo.scope) {
		case "project":
			return "Project";
		case "user":
			return "User";
		case "temporary":
			return "Temporary";
	}
}

function opaqueId(prefix: string, token: string, index: number): string {
	return `${prefix}_${token}_${(index + 1).toString(36)}`;
}

/** Collapses whitespace, redacts path-like text, and truncates to `maxLength`. */
export function boundedDisplayString(value: string | undefined, maxLength: number): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const normalized = redactPathLikeText(value)
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized) {
		return undefined;
	}
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function redactPathLikeText(value: string): string {
	return value
		.replace(/(^|[\s("'`<])file:\/\/[^\s"'`<>]+/g, `$1${REDACTED_PATH}`)
		.replace(/(^|[\s("'`<])~[^\s"'`<>]*\/[^\s"'`<>]+/g, `$1${REDACTED_PATH}`)
		.replace(/(^|[\s("'`<])[A-Za-z]:[\\/][^\s"'`<>]+/g, `$1${REDACTED_PATH}`)
		.replace(/(^|[\s("'`<])\/(?:[^\s"'`<>/]+\/)+[^\s"'`<>]*/g, `$1${REDACTED_PATH}`);
}
