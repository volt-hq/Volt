import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type Api, getSupportedThinkingLevels, type Model, supportsFastInference } from "@hansjm10/volt-ai";
import type { AgentSessionServices } from "../../agent-session-services.ts";
import { DEFAULT_THINKING_LEVEL } from "../../defaults.ts";
import { findInitialModel } from "../../model-resolver.ts";
import type { RpcAgentMode, RpcCatalogModel } from "../../rpc/types.ts";

export interface IrohRemoteAgentOptionsModelSelection {
	provider: string;
	modelId: string;
}

export interface IrohRemoteAgentOptionsDefaultConfig {
	model: IrohRemoteAgentOptionsModelSelection;
	thinkingLevel: ThinkingLevel;
	fastModeEnabled: boolean;
	agentMode: RpcAgentMode;
}

export interface IrohRemoteAgentOptions {
	workspaceName: string;
	models: RpcCatalogModel[];
	defaultConfig: IrohRemoteAgentOptionsDefaultConfig;
}

export interface IrohRemoteAgentOptionsRpcBackend {
	getAgentOptions(workspaceName: string): Promise<IrohRemoteAgentOptions>;
}

export async function createIrohRemoteAgentOptions(
	workspaceName: string,
	services: AgentSessionServices,
	signal?: AbortSignal,
): Promise<IrohRemoteAgentOptions> {
	services.modelRegistry.refreshFromDisk();
	const providers = new Set(services.modelRegistry.getAll().map((model) => model.provider));
	signal?.throwIfAborted();
	const providerRefresh = Promise.all(
		Array.from(providers, (provider) => services.modelRegistry.getApiKeyForProvider(provider)),
	);
	if (signal) {
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => reject(signal.reason);
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
			providerRefresh.then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	} else {
		await providerRefresh;
	}
	services.modelRegistry.refresh();
	const models = services.modelRegistry
		.getAvailable()
		.map(toIrohRemoteAgentOptionsCatalogModel)
		.sort((left, right) =>
			left.provider === right.provider
				? left.id.localeCompare(right.id)
				: left.provider.localeCompare(right.provider),
		);
	const initial = await findInitialModel({
		scopedModels: [],
		isContinuing: false,
		defaultProvider: services.settingsManager.getDefaultProvider(),
		defaultModelId: services.settingsManager.getDefaultModel(),
		defaultThinkingLevel: services.settingsManager.getDefaultThinkingLevel(),
		modelRegistry: services.modelRegistry,
	});
	const selected = initial.model ? models.find((model) => sameModel(model, initial.model!)) : models[0];
	if (!selected) {
		throw new Error("No authenticated models are available for agent configuration");
	}
	const requestedThinking = services.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	const thinkingLevel = selected.availableThinkingLevels.includes(requestedThinking) ? requestedThinking : "off";
	return {
		workspaceName,
		models,
		defaultConfig: {
			model: { provider: selected.provider, modelId: selected.id },
			thinkingLevel,
			fastModeEnabled: false,
			agentMode: "build",
		},
	};
}

export function toIrohRemoteAgentOptionsCatalogModel(model: Model<Api>): RpcCatalogModel {
	return {
		...model,
		availableThinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
		supportsFastMode: supportsFastInference(model),
	};
}

function sameModel(catalog: RpcCatalogModel, model: Model<Api>): boolean {
	return catalog.provider === model.provider && catalog.id === model.id;
}
