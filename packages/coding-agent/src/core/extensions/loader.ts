/**
 * Extension loader: reads each extension's manifest, settles which extension
 * owns each manifest id, and runs the owners' factories. Modules load through
 * jiti.
 *
 * A package's manifest is read from package.json without running its code. A
 * single-file extension's module is evaluated to read its exported manifest,
 * which only paths from trusted locations get: a path installed from npm or
 * git must be a package with a manifest. Two extensions never share an id: a
 * user's or temporary extension beats a project's, and otherwise the earlier
 * one in load order wins. The later one is not loaded and is reported.
 *
 * An extension that settings disable (`extensions.<id>.enabled: false`) owns
 * its id but does not run: no factory runs and a package's entry is not
 * imported until it is enabled. Each instance has a lifetime; once retired
 * (disabled, reloaded, or failed), its `volt` throws, its event-bus
 * listeners are removed, and the providers it registered are unregistered by
 * whoever retires it.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as _bundledVoltAgentCore from "@hansjm10/volt-agent-core";
import type { JsonCompatibleInput } from "@hansjm10/volt-ai";
import * as _bundledVoltAi from "@hansjm10/volt-ai";
import * as _bundledVoltAiOauth from "@hansjm10/volt-ai/oauth";
import type { ExtensionSettingsScope } from "@hansjm10/volt-protocol";
import * as _bundledVoltProtocol from "@hansjm10/volt-protocol";
import { EXTENSION_INTENT_NAME_PATTERN, REMOTE_CAPABILITIES, type RemoteCapability } from "@hansjm10/volt-protocol";
import type { KeyId } from "@hansjm10/volt-tui";
import { createJiti } from "jiti/static";
// Static imports of packages that extensions may use.
// These MUST be static so the standalone bundler includes them.
// The virtualModules option then makes them available to extensions.
import * as _bundledTypebox from "typebox";
import { type TObject, Type } from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import { Compile } from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import { CONFIG_DIR_NAME, getAgentDir, isBundledCli, isStandaloneBinary } from "../../config.ts";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @hansjm10/volt-coding-agent.
import * as _bundledVoltCodingAgent from "../../index.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import { isSafeFormPattern } from "../host/live-state.ts";
import { RESERVED_PLAN_COMMAND_NAMES, RESERVED_PLAN_TOOL_NAMES } from "../planning.ts";
import { createSyntheticSourceInfo, type SourceInfo, type SourceScope } from "../source-info.ts";
import { HOST_CUSTOM_MESSAGE_TYPES } from "../ui/message-presenters.ts";
import type { MessagePresenter } from "../ui/presentation.ts";
import { EXTENSION_KINDS_MAX, validateWorkKind } from "../work/extension-kinds.ts";
import {
	declaresPackageExtension,
	type ExtensionManifest,
	ExtensionManifestError,
	LOCAL_EXTENSION_VERSION,
	readModuleManifest,
	readPackageManifest,
	validateManifest,
} from "./manifest.ts";
import { ExtensionPermissionError, extensionFingerprint, requirePermission } from "./permissions.ts";
import { type ExtensionHandlerFn, ExtensionHandlerRegistry } from "./policy-registration.ts";
import { ExtensionSettingsRuntime } from "./settings.ts";
import {
	EXTENSION_EVENT_NAMES,
	type Extension,
	type ExtensionAPI,
	type ExtensionCompletionProvider,
	type ExtensionDeclaration,
	type ExtensionDefinition,
	type ExtensionFactory,
	type ExtensionIntentOptions,
	ExtensionLifetime,
	type ExtensionRuntime,
	type LoadExtensionsResult,
	type MessageRenderer,
	type ProviderConfig,
	type RegisteredCommand,
	type RegisteredIntent,
	type ToolDefinition,
	type WorkKindDeclaration,
} from "./types.ts";

const EXTENSION_EVENTS: ReadonlySet<string> = new Set(EXTENSION_EVENT_NAMES);

/** Host module instances served to every extension instead of per-extension copies. */
const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@hansjm10/volt-agent-core": _bundledVoltAgentCore,
	"@hansjm10/volt-ai": _bundledVoltAi,
	"@hansjm10/volt-ai/oauth": _bundledVoltAiOauth,
	"@hansjm10/volt-protocol": _bundledVoltProtocol,
	"@hansjm10/volt-coding-agent": _bundledVoltCodingAgent,
};

const moduleUrl: string | undefined = import.meta.url;
const require = createRequire(moduleUrl || pathToFileURL(process.execPath).href);

type ImportMetaWithResolve = ImportMeta & { resolve?: (specifier: string) => string };

function resolveImportSpecifier(specifier: string): string {
	const resolveSpecifier = (import.meta as ImportMetaWithResolve).resolve;
	if (typeof resolveSpecifier === "function") {
		const resolved = resolveSpecifier(specifier);
		return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
	}
	return require.resolve(specifier);
}

/**
 * Get aliases for jiti (used in Node.js/development mode).
 * In standalone binary mode, virtualModules is used instead.
 */
let _aliases: Record<string, string> | null = null;

function getAliases(): Record<string, string> {
	if (_aliases) return _aliases;

	const __dirname = moduleUrl ? path.dirname(fileURLToPath(moduleUrl)) : path.dirname(process.execPath);
	const sourcePackageIndex = path.resolve(__dirname, "../..", "index.ts");
	const packageIndex = fs.existsSync(sourcePackageIndex)
		? sourcePackageIndex
		: path.resolve(__dirname, "../..", "index.js");

	const typeboxEntry = require.resolve("typebox");
	const typeboxCompileEntry = require.resolve("typebox/compile");
	const typeboxValueEntry = require.resolve("typebox/value");

	const packagesRoot = path.resolve(__dirname, "../../../../");
	const resolveWorkspaceOrImport = (
		distWorkspaceRelativePath: string,
		sourceWorkspaceRelativePath: string,
		specifier: string,
	): string => {
		const distWorkspacePath = path.join(packagesRoot, distWorkspaceRelativePath);
		if (fs.existsSync(distWorkspacePath)) {
			return distWorkspacePath;
		}
		const sourceWorkspacePath = path.join(packagesRoot, sourceWorkspaceRelativePath);
		if (fs.existsSync(sourceWorkspacePath)) {
			return sourceWorkspacePath;
		}
		return resolveImportSpecifier(specifier);
	};

	const voltCodingAgentEntry = packageIndex;
	const voltAgentCoreEntry = resolveWorkspaceOrImport(
		"agent/dist/index.js",
		"agent/src/index.ts",
		"@hansjm10/volt-agent-core",
	);
	const voltAiEntry = resolveWorkspaceOrImport("ai/dist/index.js", "ai/src/index.ts", "@hansjm10/volt-ai");
	const voltAiOauthEntry = resolveWorkspaceOrImport("ai/dist/oauth.js", "ai/src/oauth.ts", "@hansjm10/volt-ai/oauth");
	const voltProtocolEntry = resolveWorkspaceOrImport(
		"protocol/dist/index.js",
		"protocol/src/index.ts",
		"@hansjm10/volt-protocol",
	);

	_aliases = {
		"@hansjm10/volt-coding-agent": voltCodingAgentEntry,
		"@hansjm10/volt-agent-core": voltAgentCoreEntry,
		"@hansjm10/volt-ai": voltAiEntry,
		"@hansjm10/volt-ai/oauth": voltAiOauthEntry,
		"@hansjm10/volt-protocol": voltProtocolEntry,
		typebox: typeboxEntry,
		"typebox/compile": typeboxCompileEntry,
		"typebox/value": typeboxValueEntry,
		"@sinclair/typebox": typeboxEntry,
		"@sinclair/typebox/compile": typeboxCompileEntry,
		"@sinclair/typebox/value": typeboxValueEntry,
	};

	return _aliases;
}

/**
 * An extension command's name, the last part of its intent
 * `extension.command.<id>.<name>`. It has no `:`, which only the host's
 * `<id>:<name>` aliases and `skill:` commands contain.
 */
const EXTENSION_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateExtensionCommandName(name: string): void {
	if (typeof name !== "string" || !EXTENSION_COMMAND_NAME_PATTERN.test(name)) {
		throw new Error(
			`Invalid extension command name ${JSON.stringify(name)}: use a letter or digit, then at most 63 letters, digits, "_", and "-"`,
		);
	}
}

const EXTENSION_INTENT_NAME = new RegExp(EXTENSION_INTENT_NAME_PATTERN);
const CAPABILITIES: ReadonlySet<string> = new Set(REMOTE_CAPABILITIES);

/** Most intents one extension registers. */
export const EXTENSION_INTENTS_MAX = 64;
/** Most completion providers one extension registers. */
export const EXTENSION_COMPLETION_PROVIDERS_MAX = 8;
/** Longest completion trigger, in characters. */
const COMPLETION_TRIGGER_MAX_CHARS = 8;
/** Longest intent label, in characters. */
const INTENT_LABEL_MAX_CHARS = 80;
/** Largest intent input schema, in characters of JSON: clients read it from the intent's descriptor. */
const INTENT_INPUT_SCHEMA_MAX_CHARS = 4 * 1024;

/** `value`, with every object and array in it frozen. */
function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const entry of Object.values(value)) deepFreeze(entry);
		Object.freeze(value);
	}
	return value;
}

/** Whether `pattern` is anchored at both ends: it starts with `^` and ends with an unescaped `$`. */
function isAnchored(pattern: string): boolean {
	const escapes = /\\*\$$/.exec(pattern)?.[0].length ?? 0;
	return pattern.startsWith("^") && escapes > 0 && (escapes - 1) % 2 === 0;
}

/**
 * Refuse schema keywords that test client input with patterns which may
 * backtrack without bound: every `pattern` must be anchored (`^…$`, as JSON
 * Schema tests patterns unanchored) and safe to test, as a form field's is;
 * `patternProperties` is not supported.
 */
function checkSchemaPatterns(name: string, value: unknown): void {
	if (Array.isArray(value)) {
		for (const entry of value) checkSchemaPatterns(name, entry);
		return;
	}
	if (!isRecord(value)) return;
	for (const [key, entry] of Object.entries(value)) {
		if (key === "patternProperties") {
			throw new TypeError(`Intent ${name}: input schemas do not support patternProperties`);
		}
		if (key === "pattern" && typeof entry === "string" && !(isAnchored(entry) && isSafeFormPattern(entry))) {
			throw new TypeError(
				`Intent ${name}: input pattern ${JSON.stringify(entry)} must be anchored with ^ and $, and must not repeat a repeating group or use backreferences`,
			);
		}
		checkSchemaPatterns(name, entry);
	}
}

/**
 * An intent's input schema, checked and owned: a JSON object schema of at most
 * {@link INTENT_INPUT_SCHEMA_MAX_CHARS}, with safe patterns, that compiles;
 * copied and frozen, so what the descriptor shows is what checks input.
 */
function intentInputSchema(name: string, input: unknown): TObject {
	if (!isRecord(input) || input.type !== "object") {
		throw new TypeError(`Intent ${name}: input must be a TypeBox object schema`);
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(input);
	} catch {
		json = undefined;
	}
	if (json === undefined) throw new TypeError(`Intent ${name}: input schema must be JSON`);
	if (json.length > INTENT_INPUT_SCHEMA_MAX_CHARS) {
		throw new TypeError(
			`Intent ${name}: input schema is larger than ${INTENT_INPUT_SCHEMA_MAX_CHARS} characters of JSON`,
		);
	}
	const schema = JSON.parse(json) as TObject;
	checkSchemaPatterns(name, schema);
	try {
		Compile(schema);
	} catch (error) {
		throw new TypeError(
			`Intent ${name}: input schema does not compile: ${error instanceof Error ? error.message : error}`,
		);
	}
	return deepFreeze(schema);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A name the extension gives an intent or a completion provider; throws what the author must fix. */
function validateContributionName(what: string, name: unknown): asserts name is string {
	if (typeof name !== "string" || !EXTENSION_INTENT_NAME.test(name)) {
		throw new Error(
			`Invalid ${what} name ${JSON.stringify(name)}: use a letter or digit, then at most 63 letters, digits, "_", and "-"`,
		);
	}
}

/** An intent declaration of extension `extensionId`, checked and copied. */
function validateIntent(extensionId: string, name: string, options: unknown): RegisteredIntent {
	validateContributionName("intent", name);
	if (!isRecord(options)) throw new TypeError(`Intent ${name} must be declared as an object`);
	const { label, description, input, remote = false, requires = [], handler } = options;
	if (typeof label !== "string" || label.trim().length === 0 || label.length > INTENT_LABEL_MAX_CHARS) {
		throw new TypeError(`Intent ${name}: label must be 1 to ${INTENT_LABEL_MAX_CHARS} characters`);
	}
	if (description !== undefined && typeof description !== "string") {
		throw new TypeError(`Intent ${name}: description must be a string`);
	}
	const schema = input === undefined ? undefined : intentInputSchema(name, input);
	if (typeof remote !== "boolean") throw new TypeError(`Intent ${name}: remote must be a boolean`);
	const capabilities: unknown[] | undefined = Array.isArray(requires) ? [...requires] : undefined;
	if (!capabilities?.every((capability) => typeof capability === "string" && CAPABILITIES.has(capability))) {
		throw new TypeError(`Intent ${name}: requires must list remote capabilities`);
	}
	if (typeof handler !== "function") throw new TypeError(`Intent ${name}: handler must be a function`);
	return Object.freeze({
		name,
		intent: `extension.intent.${extensionId}.${name}`,
		label,
		...(description === undefined ? {} : { description }),
		input: schema ?? Type.Object({}, { additionalProperties: false }),
		remote,
		requires: Object.freeze([...new Set(capabilities as RemoteCapability[])]),
		handler: handler as RegisteredIntent["handler"],
		extensionId,
	});
}

/**
 * The intent a shortcut of extension `extensionId` invokes: one of its own
 * intents or commands. A name without a `.` names one of its intents.
 */
function shortcutIntent(extensionId: string, intent: unknown): string {
	if (typeof intent !== "string" || intent.length === 0) {
		throw new TypeError("A shortcut needs the intent it invokes");
	}
	if (!intent.includes(".")) {
		validateContributionName("intent", intent);
		return `extension.intent.${extensionId}.${intent}`;
	}
	for (const prefix of [`extension.intent.${extensionId}.`, `extension.command.${extensionId}.`]) {
		if (intent.startsWith(prefix)) {
			validateContributionName("intent", intent.slice(prefix.length));
			return intent;
		}
	}
	throw new Error(`A shortcut of extension ${extensionId} invokes only its own intents and commands, not ${intent}`);
}

/** A completion trigger: 1 to 8 characters without whitespace or control characters. */
function validateTrigger(name: string, trigger: unknown): string {
	if (
		typeof trigger !== "string" ||
		trigger.length === 0 ||
		[...trigger].length > COMPLETION_TRIGGER_MAX_CHARS ||
		/[\s\p{Cc}]/u.test(trigger)
	) {
		throw new TypeError(
			`Completion provider ${name}: trigger must be 1 to ${COMPLETION_TRIGGER_MAX_CHARS} characters without whitespace`,
		);
	}
	return trigger;
}

/**
 * Create a runtime with throwing stubs for action methods.
 * Runner.bindCore() replaces these with real implementations.
 *
 * @param settings The extensions' settings; without them each extension sees
 *   its defaults until the session binds its settings manager.
 */
export function createExtensionRuntime(settings = new ExtensionSettingsRuntime()): ExtensionRuntime {
	const notInitialized = () => {
		throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
	};
	const state: { staleMessage?: string } = {};
	const assertActive = () => {
		if (state.staleMessage) {
			throw new Error(state.staleMessage);
		}
	};

	const runtime: ExtensionRuntime = {
		settings,
		sendMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		getServicesStatus: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during extension load; refresh is only needed post-bind.
		refreshTools: () => {},
		// Likewise registerWorkKind(): the session registers declared kinds when the runner binds.
		refreshWorkKinds: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Extension runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		assertActive,
		invalidate: (message) => {
			state.staleMessage ??=
				message ??
				"This extension ctx is stale after session replacement or reload. Do not use a captured volt or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";
		},
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, extensionId = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, extensionId });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
		},
	};

	return runtime;
}

/**
 * Create the ExtensionAPI for an extension.
 * Registration methods write to the extension object.
 * Action methods delegate to the shared runtime.
 */
function createExtensionAPI(
	extension: Extension,
	runtime: ExtensionRuntime,
	cwd: string,
	eventBus: EventBus,
): ExtensionAPI {
	// Calls throw once the runtime's generation is stale or this instance retired.
	const assertActive = (): void => {
		runtime.assertActive();
		extension.lifetime.assertActive();
	};
	// Registrations and changes throw once the instance stopped too: a disabled extension contributes and
	// steers nothing more, while what it runs (its tool calls) finishes.
	const assertRunning = (): void => {
		runtime.assertActive();
		extension.lifetime.assertRunning();
	};
	const api = {
		get settings() {
			assertActive();
			return runtime.settings.values(extension);
		},

		updateSettings(values: Readonly<Record<string, unknown>>, options?: { readonly scope?: ExtensionSettingsScope }) {
			assertRunning();
			return runtime.settings.update(extension, values, options?.scope ?? "global");
		},

		// Registration methods - write to extension
		on(event: string, handler: ExtensionHandlerFn) {
			if (!EXTENSION_EVENTS.has(event)) {
				throw new Error(`Extension '${extension.id}' subscribes to unknown event '${event}'`);
			}
			return extension.handlers.register(event, handler, assertRunning);
		},

		registerTool(tool: ToolDefinition): void {
			assertRunning();
			if (RESERVED_PLAN_TOOL_NAMES.has(tool.name)) {
				throw new Error(`Extension tool '${tool.name}' is reserved by native Plan mode`);
			}
			extension.tools.set(tool.name, {
				definition: tool,
				sourceInfo: extension.sourceInfo,
				extensionId: extension.id,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			assertRunning();
			validateExtensionCommandName(name);
			if (RESERVED_PLAN_COMMAND_NAMES.has(name)) {
				throw new Error(`Extension command '/${name}' is reserved by native Plan mode`);
			}
			extension.commands.set(name, {
				...options,
				name,
				sourceInfo: extension.sourceInfo,
			});
		},

		registerIntent(name: string, options: ExtensionIntentOptions): string {
			assertRunning();
			const intent = validateIntent(extension.id, name, options);
			if (extension.intents.has(name)) throw new Error(`Intent ${name} is already registered`);
			if (extension.intents.size >= EXTENSION_INTENTS_MAX) {
				throw new Error(`An extension registers at most ${EXTENSION_INTENTS_MAX} intents`);
			}
			extension.intents.set(name, intent);
			return intent.intent;
		},

		registerShortcut(shortcut: KeyId, options: { description?: string; intent: string }): void {
			assertRunning();
			if (typeof shortcut !== "string" || shortcut.trim().length === 0) {
				throw new TypeError("A shortcut needs a key");
			}
			if (!isRecord(options)) throw new TypeError(`Shortcut ${shortcut} must be declared as an object`);
			const { description } = options;
			if (description !== undefined && typeof description !== "string") {
				throw new TypeError(`Shortcut ${shortcut}: description must be a string`);
			}
			extension.shortcuts.set(shortcut, {
				shortcut,
				...(description === undefined ? {} : { description }),
				intent: shortcutIntent(extension.id, options.intent),
				extensionId: extension.id,
			});
		},

		registerCompletionProvider(name: string, provider: ExtensionCompletionProvider): void {
			assertRunning();
			validateContributionName("completion provider", name);
			if (!isRecord(provider)) throw new TypeError(`Completion provider ${name} must be declared as an object`);
			const { trigger, remote = false, complete } = provider;
			if (typeof remote !== "boolean") throw new TypeError(`Completion provider ${name}: remote must be a boolean`);
			if (typeof complete !== "function") {
				throw new TypeError(`Completion provider ${name}: complete must be a function`);
			}
			if (extension.completionProviders.has(name))
				throw new Error(`Completion provider ${name} is already registered`);
			if (extension.completionProviders.size >= EXTENSION_COMPLETION_PROVIDERS_MAX) {
				throw new Error(
					`An extension registers at most ${EXTENSION_COMPLETION_PROVIDERS_MAX} completion providers`,
				);
			}
			extension.completionProviders.set(
				name,
				Object.freeze({
					name,
					trigger: validateTrigger(name, trigger),
					remote,
					complete: complete as ExtensionCompletionProvider["complete"],
					extensionId: extension.id,
				}),
			);
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			assertRunning();
			extension.flags.set(name, { ...options, name, extensionId: extension.id });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				runtime.flagValues.set(name, options.default);
			}
		},

		registerWorkKind(name: string, kind?: WorkKindDeclaration): void {
			assertRunning();
			const declaration = validateWorkKind(name, kind);
			if (extension.workKinds.has(name)) throw new Error(`Work kind ${name} is already registered`);
			if (extension.workKinds.size >= EXTENSION_KINDS_MAX) {
				throw new Error(`An extension registers at most ${EXTENSION_KINDS_MAX} work kinds`);
			}
			extension.workKinds.set(name, declaration);
			runtime.refreshWorkKinds();
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			assertRunning();
			extension.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerMessagePresenter<T>(customType: string, present: MessagePresenter<T>): void {
			assertRunning();
			if (typeof customType !== "string" || customType.length === 0) {
				throw new TypeError("A message presenter needs the custom type it presents");
			}
			if (typeof present !== "function") throw new TypeError(`Message presenter ${customType} must be a function`);
			if (HOST_CUSTOM_MESSAGE_TYPES.has(customType)) {
				throw new Error(`Custom messages of type ${customType} are the host's; an extension cannot present them`);
			}
			extension.messagePresenters.set(customType, present as MessagePresenter);
		},

		// Flag access - checks extension registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			assertActive();
			if (!extension.flags.has(name)) return undefined;
			return runtime.flagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			assertRunning();
			runtime.sendMessage(message, options);
		},

		sendUserMessage(content, options): void {
			assertRunning();
			runtime.sendUserMessage(content, options);
		},

		appendEntry<T>(customType: string, data?: JsonCompatibleInput<T>): Promise<void> {
			assertRunning();
			return runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): Promise<void> {
			assertRunning();
			return runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			assertActive();
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): Promise<void> {
			assertRunning();
			return runtime.setLabel(entryId, label);
		},

		getServicesStatus() {
			assertActive();
			return runtime.getServicesStatus(extension.id);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			assertActive();
			if (!extension.manifest.permissions?.includes("exec")) {
				return Promise.reject(new ExtensionPermissionError(extension.id, "exec", "volt.exec"));
			}
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			assertActive();
			return runtime.getActiveTools();
		},

		getAllTools() {
			assertActive();
			return runtime.getAllTools();
		},

		setActiveTools(toolNames: string[]): void {
			assertRunning();
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			assertActive();
			return runtime.getCommands();
		},

		setModel(model) {
			assertRunning();
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			assertActive();
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			assertRunning();
			runtime.setThinkingLevel(level);
		},

		registerProvider(name: string, config: ProviderConfig) {
			assertRunning();
			requirePermission(extension, "providers", "volt.registerProvider");
			runtime.registerProvider(name, config, extension.id);
			extension.providers.add(name);
		},

		unregisterProvider(name: string) {
			assertRunning();
			requirePermission(extension, "providers", "volt.unregisterProvider");
			runtime.unregisterProvider(name, extension.id);
			extension.providers.delete(name);
		},

		events: {
			emit(channel, data) {
				assertRunning();
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				assertRunning();
				const unsubscribe = eventBus.on(channel, (data) => {
					try {
						assertActive();
					} catch {
						// Shared buses may outlive this extension generation.
						return;
					}
					return handler(data);
				});
				// A retired instance's listeners leave the bus.
				const forget = extension.lifetime.onRetire(unsubscribe);
				return () => {
					forget();
					unsubscribe();
				};
			},
		},
	} as ExtensionAPI;

	return api;
}

/** Evaluate a module: its namespace, whose default export is the factory and whose `manifest` is a single file's manifest. */
async function importModule(modulePath: string): Promise<unknown> {
	const jiti = createJiti(moduleUrl || pathToFileURL(process.execPath).href, {
		moduleCache: false,
		// Serve Volt packages and typebox from the host's loaded instances. Without this, a source
		// checkout would re-evaluate the coding-agent sources for every extension load.
		virtualModules: VIRTUAL_MODULES,
		// In a standalone binary: disable tryNative so jiti handles ALL imports (not just the entry point)
		// In Node.js/dev: aliases resolve package subpaths the virtual module map does not cover
		...(isStandaloneBinary || isBundledCli ? { tryNative: false } : { alias: getAliases() }),
	});
	return jiti.import(modulePath);
}

/** A module's default export when it is a function; a CommonJS module may export the function itself. */
function moduleFactory(module: unknown): ExtensionFactory | undefined {
	const exported =
		(typeof module === "object" && module !== null) || typeof module === "function"
			? (Reflect.get(module, "default") ?? module)
			: module;
	return typeof exported === "function" ? (exported as ExtensionFactory) : undefined;
}

/** A module without a default-exported factory; its message is reported as is. */
class MissingFactoryError extends Error {}

/** Something to load an extension from, and where it was found. */
export interface ExtensionSource {
	/** A module, a directory, or a package root; for an SDK extension, its label (`<inline:1>`). */
	readonly path: string;
	/**
	 * Where it was found: a user's or temporary extension beats a project's
	 * with the same id. Defaults to `temporary`.
	 */
	readonly scope?: SourceScope;
	/**
	 * Installed from npm or git: it loads only as a package whose package.json
	 * declares its manifest, and no module code runs to find one.
	 */
	readonly installed?: boolean;
	/** An SDK extension, loaded instead of `path`. */
	readonly definition?: ExtensionDefinition;
	/** The npm, git, or local package source it was installed from: its permission fingerprint names it. */
	readonly packageSource?: string;
}

/** An extension whose manifest was read, before its factory runs. */
interface Candidate {
	readonly path: string;
	readonly resolvedPath: string;
	readonly scope: SourceScope;
	readonly manifest: ExtensionManifest;
	readonly version: string;
	readonly baseDir: string | undefined;
	readonly packageSource: string | undefined;
	/** The factory; a package's entry module is imported only once the package owns its id. */
	readonly factory: () => Promise<ExtensionFactory>;
}

function isDirectory(target: string): boolean {
	try {
		return fs.statSync(target).isDirectory();
	} catch {
		return false;
	}
}

/** An SDK extension: its manifest checked and its factory taken, each read once. */
function definitionCandidate(definition: ExtensionDefinition, label: string, scope: SourceScope): Candidate {
	const { manifest, factory } = definition;
	if (typeof factory !== "function") throw new MissingFactoryError(`Extension ${label} has no factory function`);
	return {
		path: label,
		resolvedPath: label,
		scope,
		manifest: validateManifest(manifest, { package: false }),
		version: LOCAL_EXTENSION_VERSION,
		baseDir: undefined,
		packageSource: undefined,
		factory: async () => factory,
	};
}

/** Read what `source` declares: a package's manifest without running its code, or a trusted module's export. */
async function prepareExtension(source: ExtensionSource, cwd: string): Promise<Candidate> {
	const scope = source.scope ?? "temporary";
	if (source.definition !== undefined) return definitionCandidate(source.definition, source.path, scope);
	const resolvedPath = resolvePath(source.path, cwd, { normalizeUnicodeSpaces: true });
	const base = { path: source.path, resolvedPath, scope, packageSource: source.packageSource };
	if (isDirectory(resolvedPath) && declaresPackageExtension(resolvedPath)) {
		const declared = readPackageManifest(resolvedPath);
		if (declared === undefined) throw new ExtensionManifestError("package.json declares no extension");
		return {
			...base,
			manifest: declared.manifest,
			version: declared.version,
			baseDir: resolvedPath,
			factory: async () => {
				const factory = moduleFactory(await importModule(declared.entryPath));
				if (!factory) {
					throw new MissingFactoryError(
						`Extension does not export a valid factory function: ${declared.entryPath}`,
					);
				}
				return factory;
			},
		};
	}
	if (source.installed) {
		throw new ExtensionManifestError(
			`An extension installed from npm or git must be a package that declares its manifest in the "volt" field of package.json ("id", "displayName", and "entry")`,
		);
	}
	const module = await importModule(resolvedPath);
	const manifest = readModuleManifest(module);
	const factory = moduleFactory(module);
	if (!factory) throw new MissingFactoryError(`Extension does not export a valid factory function: ${source.path}`);
	return {
		...base,
		manifest,
		version: LOCAL_EXTENSION_VERSION,
		baseDir: path.dirname(resolvedPath),
		factory: async () => factory,
	};
}

/** What an extension declares, read as loading reads it, before its factory runs. */
export interface DeclaredExtension {
	readonly manifest: ExtensionManifest;
	readonly version: string;
	readonly scope: SourceScope;
	/** See {@link Extension.fingerprint}. */
	readonly fingerprint: string;
}

/**
 * Read what `source` declares as loading would: a package's manifest from
 * package.json, or a trusted module's exported manifest (evaluating the
 * module, never its factory). Throws when there is no valid manifest.
 */
export async function readDeclaredExtension(source: ExtensionSource, cwd: string): Promise<DeclaredExtension> {
	const candidate = await prepareExtension(source, resolvePath(cwd));
	return {
		manifest: candidate.manifest,
		version: candidate.version,
		scope: candidate.scope,
		fingerprint: candidateFingerprint(candidate),
	};
}

function candidateFingerprint(candidate: Candidate): string {
	return extensionFingerprint({
		id: candidate.manifest.id,
		path: candidate.resolvedPath,
		...(candidate.packageSource === undefined ? {} : { packageSource: candidate.packageSource }),
	});
}

function loadError(error: unknown): string {
	if (error instanceof ExtensionManifestError) return `Invalid extension manifest: ${error.message}`;
	if (error instanceof MissingFactoryError) return error.message;
	return `Failed to load extension: ${error instanceof Error ? error.message : String(error)}`;
}

/** Create an Extension object with empty collections. */
function createExtension(candidate: Candidate): Extension {
	const label = candidate.path.startsWith("<") && candidate.path.endsWith(">");
	const source = label ? candidate.path.slice(1, -1).split(":")[0] || "temporary" : "local";

	return {
		id: candidate.manifest.id,
		manifest: candidate.manifest,
		version: candidate.version,
		path: candidate.path,
		resolvedPath: candidate.resolvedPath,
		sourceInfo: createSyntheticSourceInfo(candidate.path, {
			source,
			scope: candidate.scope,
			baseDir: candidate.baseDir,
		}),
		fingerprint: candidateFingerprint(candidate),
		handlers: new ExtensionHandlerRegistry(),
		tools: new Map(),
		messageRenderers: new Map(),
		messagePresenters: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
		intents: new Map(),
		completionProviders: new Map(),
		workKinds: new Map(),
		providers: new Set(),
		clientRegistrations: new Set(),
		lifetime: new ExtensionLifetime(),
	};
}

/**
 * Retire an instance whose load failed: its calls throw, and the providers it
 * registered go, whether still queued for the runner or applied.
 */
function retireFailed(extension: Extension, runtime: ExtensionRuntime): void {
	extension.lifetime.retire(`Extension ${extension.id} failed to load`);
	const queued = runtime.pendingProviderRegistrations.some(
		(registration) => registration.extensionId === extension.id,
	);
	if (queued) {
		runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter(
			(registration) => registration.extensionId !== extension.id,
		);
	} else {
		for (const name of extension.providers) {
			try {
				runtime.unregisterProvider(name, extension.id);
			} catch {
				// The provider is gone either way.
			}
		}
	}
	extension.providers.clear();
}

/**
 * Run `candidate`'s factory into `runtime` as a new instance; `sourceInfo`
 * replaces the instance's own source. A failed instance is retired.
 */
async function runCandidate(
	candidate: Candidate,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	sourceInfo?: SourceInfo,
): Promise<Extension> {
	const factory = await candidate.factory();
	const extension = createExtension(candidate);
	if (sourceInfo !== undefined) extension.sourceInfo = sourceInfo;
	try {
		await factory(createExtensionAPI(extension, runtime, cwd, eventBus));
	} catch (error) {
		retireFailed(extension, runtime);
		throw error;
	}
	return extension;
}

/** An extension that owns its id; `load` runs a new instance of it into `runtime`. */
function declareCandidate(
	candidate: Candidate,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	error?: string,
): ExtensionDeclaration {
	const declared = createExtension(candidate);
	const declaration: ExtensionDeclaration = {
		id: declared.id,
		manifest: declared.manifest,
		version: declared.version,
		path: declared.path,
		resolvedPath: declared.resolvedPath,
		sourceInfo: declared.sourceInfo,
		fingerprint: declared.fingerprint,
		...(error === undefined ? {} : { error }),
		load: () => runCandidate(candidate, cwd, eventBus, runtime, declaration.sourceInfo),
	};
	return declaration;
}

/**
 * The candidates that own their manifest ids, in load order. An id an
 * already loaded extension has stays its. Otherwise a user's or temporary
 * extension beats a project's, and the earlier one beats the later. Each
 * extension that loses is reported.
 */
function settleIds(
	candidates: readonly Candidate[],
	loaded: readonly { readonly id: string; readonly path: string }[],
	errors: LoadExtensionsResult["errors"],
): Candidate[] {
	const taken = new Map(loaded.map((extension) => [extension.id, extension.path]));
	const owners = new Map<string, Candidate>();
	const reject = (candidate: Candidate, ownerPath: string): void => {
		errors.push({
			path: candidate.path,
			error: `Extension id "${candidate.manifest.id}" is already used by ${ownerPath}; ${candidate.path} is not loaded`,
		});
	};
	for (const candidate of candidates) {
		const id = candidate.manifest.id;
		const loadedPath = taken.get(id);
		if (loadedPath !== undefined) {
			reject(candidate, loadedPath);
			continue;
		}
		const owner = owners.get(id);
		if (owner === undefined) {
			owners.set(id, candidate);
		} else if (owner.scope === "project" && candidate.scope !== "project") {
			reject(owner, candidate.path);
			owners.set(id, candidate);
		} else {
			reject(candidate, owner.path);
		}
	}
	const winners = new Set(owners.values());
	return candidates.filter((candidate) => winners.has(candidate));
}

/**
 * Load an SDK extension. Throws when its manifest is invalid or its factory
 * fails; it is not checked against other extensions' ids.
 */
export async function loadExtensionFromFactory(
	definition: ExtensionDefinition,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	label = "<inline>",
): Promise<Extension> {
	return runCandidate(definitionCandidate(definition, label, "temporary"), resolvePath(cwd), eventBus, runtime);
}

/**
 * Load extensions from paths and SDK definitions, in order. Each manifest is
 * read first; then the extensions that own their ids and that the runtime's
 * settings enable run their factories. Every extension that owns its id is
 * declared, running or not. `loaded` are extensions already loaded into the
 * same runtime, whose ids stay theirs.
 */
export async function loadExtensions(
	sources: ReadonlyArray<string | ExtensionSource>,
	cwd: string,
	eventBus?: EventBus,
	runtime?: ExtensionRuntime,
	loaded: readonly Extension[] = [],
): Promise<LoadExtensionsResult> {
	const extensions: Extension[] = [];
	const errors: LoadExtensionsResult["errors"] = [];
	const resolvedCwd = resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const resolvedRuntime = runtime ?? createExtensionRuntime();

	const candidates: Candidate[] = [];
	for (const entry of sources) {
		const source = typeof entry === "string" ? { path: entry } : entry;
		try {
			candidates.push(await prepareExtension(source, resolvedCwd));
		} catch (error) {
			errors.push({ path: source.path, error: loadError(error) });
		}
	}

	const declarations: ExtensionDeclaration[] = [];
	for (const candidate of settleIds(candidates, loaded, errors)) {
		let error: string | undefined;
		if (resolvedRuntime.settings.enabled(candidate.manifest.id)) {
			try {
				extensions.push(await runCandidate(candidate, resolvedCwd, resolvedEventBus, resolvedRuntime));
			} catch (failure) {
				error = loadError(failure);
				errors.push({ path: candidate.path, error });
			}
		}
		declarations.push(declareCandidate(candidate, resolvedCwd, resolvedEventBus, resolvedRuntime, error));
	}

	return {
		extensions,
		declarations,
		errors,
		runtime: resolvedRuntime,
	};
}

/**
 * Read what `sources` declare, as {@link loadExtensions} does, without running
 * any factory: each source that owns its id (against `declared`, the ids the
 * runtime's extensions own already) becomes a declaration whose `load` runs it
 * into `runtime`. A single file's module is evaluated to read its manifest, as
 * loading does: only paths from trusted locations may be given.
 */
export async function declareExtensions(
	sources: ReadonlyArray<ExtensionSource>,
	cwd: string,
	eventBus: EventBus,
	runtime: ExtensionRuntime,
	declared: readonly { readonly id: string; readonly path: string }[],
): Promise<{ declarations: ExtensionDeclaration[]; errors: LoadExtensionsResult["errors"] }> {
	const errors: LoadExtensionsResult["errors"] = [];
	const resolvedCwd = resolvePath(cwd);
	const candidates: Candidate[] = [];
	for (const source of sources) {
		try {
			candidates.push(await prepareExtension(source, resolvedCwd));
		} catch (error) {
			errors.push({ path: source.path, error: loadError(error) });
		}
	}
	const declarations = settleIds(candidates, declared, errors).map((candidate) =>
		declareCandidate(candidate, resolvedCwd, eventBus, runtime),
	);
	return { declarations, errors };
}

function isExtensionFile(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".js");
}

/**
 * Resolve extension entry points from a directory.
 *
 * Checks for:
 * 1. package.json whose "volt" field declares an extension -> the directory, a package
 * 2. index.ts or index.js -> the index file, a single-file extension
 *
 * Returns resolved paths or null if no entry points found.
 */
function resolveExtensionEntries(dir: string): string[] | null {
	if (declaresPackageExtension(dir)) {
		return [dir];
	}

	// Check for index.ts or index.js
	const indexTs = path.join(dir, "index.ts");
	const indexJs = path.join(dir, "index.js");
	if (fs.existsSync(indexTs)) {
		return [indexTs];
	}
	if (fs.existsSync(indexJs)) {
		return [indexJs];
	}

	return null;
}

/**
 * Discover extensions in a directory.
 *
 * Discovery rules:
 * 1. Direct files: `extensions/*.ts` or `*.js` → load
 * 2. Subdirectory with index: `extensions/* /index.ts` or `index.js` → load
 * 3. Subdirectory with package.json: `extensions/* /package.json` declaring an extension → load the package
 *
 * No recursion beyond one level. Complex packages must use package.json manifest.
 */
function discoverExtensionsInDir(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const discovered: string[] = [];

	try {
		const entries = fs.readdirSync(dir, { withFileTypes: true });

		for (const entry of entries) {
			const entryPath = path.join(dir, entry.name);

			// 1. Direct files: *.ts or *.js
			if ((entry.isFile() || entry.isSymbolicLink()) && isExtensionFile(entry.name)) {
				discovered.push(entryPath);
				continue;
			}

			// 2 & 3. Subdirectories
			if (entry.isDirectory() || entry.isSymbolicLink()) {
				const entries = resolveExtensionEntries(entryPath);
				if (entries) {
					discovered.push(...entries);
				}
			}
		}
	} catch {
		return [];
	}

	return discovered;
}

/**
 * Discover and load extensions from standard locations: the project's
 * (scope `project`), the user's (scope `user`), then `configuredPaths`
 * (scope `temporary`). It does not check project trust: the caller decides
 * whether `cwd`'s extensions may run. Volt's own resource loading checks it.
 */
export async function discoverAndLoadExtensions(
	configuredPaths: string[],
	cwd: string,
	agentDir: string = getAgentDir(),
	eventBus?: EventBus,
): Promise<LoadExtensionsResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const sources: ExtensionSource[] = [];
	const seen = new Set<string>();

	const addPaths = (paths: string[], scope: SourceScope) => {
		for (const p of paths) {
			const resolved = path.resolve(p);
			if (!seen.has(resolved)) {
				seen.add(resolved);
				sources.push({ path: p, scope });
			}
		}
	};

	// 1. Project-local extensions: cwd/${CONFIG_DIR_NAME}/extensions/
	const localExtDir = path.join(resolvedCwd, CONFIG_DIR_NAME, "extensions");
	addPaths(discoverExtensionsInDir(localExtDir), "project");

	// 2. Global extensions: agentDir/extensions/
	const globalExtDir = path.join(resolvedAgentDir, "extensions");
	addPaths(discoverExtensionsInDir(globalExtDir), "user");

	// 3. Explicitly configured paths
	for (const p of configuredPaths) {
		const resolved = resolvePath(p, resolvedCwd, { normalizeUnicodeSpaces: true });
		if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
			// Check for a package manifest or index.ts
			const entries = resolveExtensionEntries(resolved);
			if (entries) {
				addPaths(entries, "temporary");
				continue;
			}
			// No explicit entries - discover individual files in directory
			addPaths(discoverExtensionsInDir(resolved), "temporary");
			continue;
		}

		addPaths([resolved], "temporary");
	}

	return loadExtensions(sources, resolvedCwd, eventBus);
}
