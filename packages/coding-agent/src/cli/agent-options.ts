/**
 * The agent options the CLI's arguments make: the session options a
 * conversation is created with (the in-process modes' factory and a
 * conversation worker's both build them here), and the closed
 * `WorkerSpawnOptions` a TUI opens a worker with (Phase 7 plan §1, "Spawn").
 */

import { modelsAreEqual } from "@hansjm10/volt-ai";
import type { AgentSessionDiagnostic } from "../core/agent-session-services.ts";
import type { ModelRegistry } from "../core/model-registry.ts";
import { resolveCliModel, type ScopedModel } from "../core/model-resolver.ts";
import type { CreateAgentSessionOptions } from "../core/sdk.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import type { WorkerAgentConfig, WorkerSpawnOptions } from "../daemon/control-protocol.ts";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import type { Args } from "./args.ts";

/** The CLI arguments a conversation's session options come from. */
export type SessionOptionArgs = Pick<
	Args,
	| "provider"
	| "model"
	| "thinking"
	| "plan"
	| "tools"
	| "noTools"
	| "noBuiltinTools"
	| "excludeTools"
	| "allowUnlistedExtensionTools"
>;

/** The session options `args` asks for, resolved against a conversation's models and settings. */
export function buildSessionOptions(
	args: SessionOptionArgs,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	diagnostics: AgentSessionDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionDiagnostic[] = [];

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (args.model) {
		const resolved = resolveCliModel({
			cliProvider: args.provider,
			cliModel: args.model,
			cliThinking: args.thinking,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!args.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!args.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!args.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (args.thinking) {
		options.thinkingLevel = args.thinking;
	}
	if (args.plan) {
		options.agentMode = "plan";
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (args.noTools) {
		options.noTools = "all";
	} else if (args.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (args.tools) {
		options.tools = [...args.tools];
	}
	if (args.allowUnlistedExtensionTools) {
		options.allowUnlistedExtensionTools = true;
	}
	if (args.excludeTools) {
		options.excludeTools = [...args.excludeTools];
	}

	return { options, diagnostics };
}

/** An environment variable name a spawn takes. */
const ENVIRONMENT_NAME = /^[^=\u0000-\u001f\u007f]+$/;

/** Local paths resolved against `cwd`; package sources kept. */
export function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}

/**
 * The closed spawn options of a TUI started with `args` in `cwd`: its
 * environment (strings only), its spawn-only options with local paths made
 * absolute (`--approve`/`--no-approve` as its trust override), its
 * session-level options, and its model scope.
 */
export function createWorkerSpawnOptions(
	args: Args,
	context: {
		readonly cwd: string;
		readonly env: NodeJS.ProcessEnv;
		readonly profile?: string;
	},
): WorkerSpawnOptions {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(context.env)) {
		// Names the schema refuses (control characters, `=`) cannot be logged or set; they stay behind.
		if (value !== undefined && ENVIRONMENT_NAME.test(name) && !value.includes("\0")) env[name] = value;
	}
	const config: WorkerAgentConfig = {
		...(args.projectTrustOverride === undefined ? {} : { trust: args.projectTrustOverride }),
		...(context.profile === undefined ? {} : { profile: context.profile }),
		...(args.extensions === undefined ? {} : { extensions: resolveCliPaths(context.cwd, args.extensions) }),
		...(args.noExtensions ? { noExtensions: true } : {}),
		...(args.skills === undefined ? {} : { skills: resolveCliPaths(context.cwd, args.skills) }),
		...(args.noSkills ? { noSkills: true } : {}),
		...(args.promptTemplates === undefined
			? {}
			: { promptTemplates: resolveCliPaths(context.cwd, args.promptTemplates) }),
		...(args.noPromptTemplates ? { noPromptTemplates: true } : {}),
		...(args.themes === undefined ? {} : { themes: resolveCliPaths(context.cwd, args.themes) }),
		...(args.noThemes ? { noThemes: true } : {}),
		...(args.noContextFiles ? { noContextFiles: true } : {}),
		...(args.systemPrompt === undefined ? {} : { systemPrompt: args.systemPrompt }),
		...(args.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: [...args.appendSystemPrompt] }),
		...(args.tools === undefined ? {} : { tools: [...args.tools] }),
		...(args.noTools ? { noTools: true } : {}),
		...(args.noBuiltinTools ? { noBuiltinTools: true } : {}),
		...(args.excludeTools === undefined ? {} : { excludeTools: [...args.excludeTools] }),
		...(args.allowUnlistedExtensionTools ? { allowUnlistedExtensionTools: true } : {}),
		...(args.lsp ? { lsp: true } : {}),
		...(args.apiKey === undefined ? {} : { apiKey: args.apiKey }),
		...(args.unknownFlags.size === 0 ? {} : { flags: Object.fromEntries(args.unknownFlags) }),
	};
	return {
		env,
		config,
		cwd: resolvePath(context.cwd),
		persist: args.noSession !== true,
		session: {
			...(args.provider === undefined ? {} : { provider: args.provider }),
			...(args.model === undefined ? {} : { model: args.model }),
			...(args.thinking === undefined ? {} : { thinking: args.thinking }),
			...(args.plan ? { plan: true } : {}),
		},
		...(args.models === undefined ? {} : { modelScopePatterns: [...args.models] }),
	};
}
