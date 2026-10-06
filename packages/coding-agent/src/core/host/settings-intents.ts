/**
 * The host settings clients change through intents (settings by owner):
 * the keys the host reads (`set_settings`), the settings profile
 * (`set_profile`), and the model scope (`set_model_scope`). Each saves where
 * the host keeps it, then applies to the conversation at once. Display
 * settings stay with each client; credentials change only through `auth.*`.
 */

import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type Api, type Model, modelsAreEqual } from "@hansjm10/volt-ai";
import type { HostSettingsValues, ScopedModel } from "@hansjm10/volt-protocol";
import type { AgentSession } from "../agent-session.ts";
import { configureHttpDispatcher } from "../http-dispatcher.ts";
import { resolveModelScope } from "../model-resolver.ts";

/** The model a `provider/modelId` reference names, split at its first `/`. */
function modelReference(reference: string): { provider: string; modelId: string } {
	const slash = reference.indexOf("/");
	return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
}

/**
 * Save the host-read settings `values` names, then apply them: the HTTP idle
 * timeout to the process, and the personality, transport, and prompt-cache
 * keepalive to the conversation. A review model must be one the host knows.
 */
export async function setHostSettings(session: AgentSession, values: HostSettingsValues): Promise<void> {
	const settings = session.settingsManager;
	const reviewModel = values.reviewModel;
	if (typeof reviewModel === "string") {
		const { provider, modelId } = modelReference(reviewModel);
		if (!session.modelRegistry.find(provider, modelId)) throw new Error(`Model not found: ${reviewModel}`);
	}
	if (values.personality !== undefined) settings.setPersonality(values.personality);
	if (values.transport !== undefined) settings.setTransport(values.transport);
	if (reviewModel !== undefined) settings.setReviewModel(reviewModel ?? undefined);
	if (values.promptCacheKeepAlive !== undefined) settings.setPromptCacheKeepAlive(values.promptCacheKeepAlive);
	if (values.imageAutoResize !== undefined) settings.setImageAutoResize(values.imageAutoResize);
	if (values.blockImages !== undefined) settings.setBlockImages(values.blockImages);
	if (values.httpIdleTimeoutMs !== undefined) settings.setHttpIdleTimeoutMs(values.httpIdleTimeoutMs);
	if (values.enableInstallTelemetry !== undefined) settings.setEnableInstallTelemetry(values.enableInstallTelemetry);
	await settings.flush();
	if (values.httpIdleTimeoutMs !== undefined) configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
	session.applySettings();
}

/** A model scope as settings store it: `provider/modelId`, with `:<thinking level>` when one is set. */
function scopePattern(entry: ScopedModel): string {
	return `${entry.provider}/${entry.modelId}${entry.thinkingLevel === undefined ? "" : `:${entry.thinkingLevel}`}`;
}

/**
 * Scope the conversation's model cycle to `models`, in order (none for every
 * available model). Every model must be available; `persist` saves the scope
 * as the settings' `enabledModels`.
 */
export async function setModelScope(
	session: AgentSession,
	models: readonly ScopedModel[],
	persist: boolean,
): Promise<void> {
	const available = session.modelRegistry.getAvailable();
	const scoped: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [];
	for (const entry of models) {
		const model = available.find(
			(candidate) => candidate.provider === entry.provider && candidate.id === entry.modelId,
		);
		if (!model) throw new Error(`Model not available: ${entry.provider}/${entry.modelId}`);
		if (scoped.some((held) => modelsAreEqual(held.model, model))) {
			throw new Error(`Model listed twice: ${entry.provider}/${entry.modelId}`);
		}
		scoped.push({ model, ...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }) });
	}
	session.setScopedModels(scoped);
	if (!persist) return;
	session.settingsManager.setEnabledModels(models.length === 0 ? undefined : models.map(scopePattern));
	await session.settingsManager.flush();
}

/** Scope the model cycle as the active profile says: the host's `--models` patterns first, else `enabledModels`. */
async function applyScopeFromSettings(session: AgentSession, modelScopePatterns: readonly string[] | undefined) {
	const patterns = modelScopePatterns ?? session.settingsManager.getEnabledModels();
	if (patterns === undefined || patterns.length === 0) {
		session.setScopedModels([]);
		return;
	}
	const scoped = await resolveModelScope([...patterns], session.modelRegistry);
	session.setScopedModels(
		scoped.map((entry) => ({
			model: entry.model,
			...(entry.thinkingLevel === undefined ? {} : { thinkingLevel: entry.thinkingLevel }),
		})),
	);
}

/** Select `model` and `thinkingLevel` (else the profile's default level) for the conversation; a warning when it cannot. */
async function selectModel(
	session: AgentSession,
	model: Model<Api>,
	thinkingLevel: ThinkingLevel | undefined,
): Promise<string | undefined> {
	const reference = `${model.provider}/${model.id}`;
	if (!modelsAreEqual(session.model, model)) {
		if (!session.modelRegistry.hasConfiguredAuth(model)) {
			return `Could not apply profile model ${reference}: credentials are not configured`;
		}
		try {
			await session.setModel(model, { persistDefault: false });
		} catch (error) {
			return `Could not apply profile model ${reference}: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
	const level = thinkingLevel ?? session.settingsManager.getDefaultThinkingLevel();
	if (level !== undefined) await session.setThinkingLevel(level, { persistDefault: false });
	return undefined;
}

/**
 * Select the active profile's default model, or without one its first scoped
 * model, with the scope's or the profile's thinking level. Resolves what kept
 * it from applying.
 */
async function applyProfileModel(session: AgentSession): Promise<string[]> {
	const settings = session.settingsManager;
	const defaultProvider = settings.getDefaultProvider();
	const defaultModelId = settings.getDefaultModel();
	const scope = session.scopedModels;
	if (!defaultProvider && !defaultModelId) {
		const current = session.model;
		const selected = (current ? scope.find((entry) => modelsAreEqual(entry.model, current)) : undefined) ?? scope[0];
		if (!selected) {
			const level = settings.getDefaultThinkingLevel();
			if (level !== undefined) await session.setThinkingLevel(level, { persistDefault: false });
			return [];
		}
		const warning = await selectModel(session, selected.model, selected.thinkingLevel);
		return warning === undefined ? [] : [warning];
	}
	if (!defaultProvider || !defaultModelId) {
		return ["Could not apply the profile's default model: defaultProvider/defaultModel is incomplete"];
	}
	const model = session.modelRegistry.find(defaultProvider, defaultModelId);
	if (!model) return [`Could not apply profile default model ${defaultProvider}/${defaultModelId}: model not found`];
	const scoped =
		scope.length > 0 ? (scope.find((entry) => modelsAreEqual(entry.model, model)) ?? scope[0]) : undefined;
	const warning = await selectModel(session, scoped?.model ?? model, scoped?.thinkingLevel);
	return warning === undefined ? [] : [warning];
}

export interface ProfileSwitch {
	readonly profile: string;
	readonly created: boolean;
	/** What of the profile could not apply. */
	readonly warnings: string[];
}

/**
 * Switch the conversation's settings profile, with `create` making a global
 * one of that name first: the conversation reloads its resources and
 * extensions, applies the host-read settings, then takes the profile's model
 * scope (the host's `--models` patterns win) and its default model. Switching
 * to the active profile changes nothing.
 */
export async function switchProfile(
	session: AgentSession,
	name: string,
	options: { readonly create?: boolean; readonly modelScopePatterns?: readonly string[] } = {},
): Promise<ProfileSwitch> {
	const settings = session.settingsManager;
	const profile = name.trim();
	const exists = settings.hasProfile(profile);
	if (!exists && options.create !== true) throw new Error(`Profile "${profile}" is not defined`);
	if (exists && settings.getActiveProfile() === profile) return { profile, created: false, warnings: [] };
	if (!exists) {
		settings.ensureGlobalProfile(profile);
		await settings.flush();
	}
	settings.setActiveProfile(profile);
	await session.reload();
	configureHttpDispatcher(settings.getHttpIdleTimeoutMs());
	session.applySettings();
	const warnings: string[] = [];
	try {
		await applyScopeFromSettings(session, options.modelScopePatterns);
	} catch (error) {
		warnings.push(`Could not apply profile model scope: ${error instanceof Error ? error.message : String(error)}`);
	}
	warnings.push(...(await applyProfileModel(session)));
	return { profile, created: !exists, warnings };
}
