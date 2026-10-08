/**
 * The session's model selection and runtime settings: the model, thinking
 * level, and Fast mode the active branch names (all from the log), the object
 * each selection resolves to, the scoped models, queue modes,
 * and provider stream options. A selection the user makes also becomes the
 * settings default unless the caller opts out.
 */

import type { AgentTool, Conversation, ConversationStreamOptions, ThinkingLevel } from "@hansjm10/volt-agent-core";
import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	modelsAreEqual,
} from "@hansjm10/volt-ai";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { ExtensionRunner } from "../extensions/index.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { SessionManager } from "../session-manager.ts";
import type { SettingsManager } from "../settings-manager.ts";

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The key a model selection is remembered by: provider and id, as the log names it. */
function modelKey(provider: string, modelId: string): string {
	return `${provider}\u0000${modelId}`;
}

export interface DefaultPersistenceOptions {
	persistDefault?: boolean;
}

/** How a model was chosen: picked (`set`, the default), or stepped to through the cycle scope (`cycle`). */
export interface ModelSelectOptions extends DefaultPersistenceOptions {
	source?: "set" | "cycle";
}

export interface ModelSettingsHost {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly modelRegistry: ModelRegistry;
	conversation(): Conversation<AgentTool>;
	extensionRunner(): ExtensionRunner;
	/** Rejects once the session is disposed or has lost its log. */
	assertActive(): void;
	/** Re-derive the active tools and system prompt for the selected model and the plan state. */
	syncPlanningRuntime(): void;
	publishPromptCacheStatus(): void;
	emit(event: AgentSessionEvent): void;
}

export interface ModelSettingsOptions {
	/** The configured model; it resolves its own selection even when the registry does not list it. */
	model?: Model<Api>;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	streamOptions?: ConversationStreamOptions;
}

export class ModelSettings {
	private readonly host: ModelSettingsHost;
	/**
	 * The model object each selection resolves to, by provider and id: the
	 * configured model, explicit selections, and registry refreshes after a
	 * provider change. The log names a model by provider and id only.
	 */
	private readonly selectedModels = new Map<string, Model<Api>>();
	private scoped: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	/** Curated provider options the conversation reads for every request. Fast mode comes from the log. */
	private options: ConversationStreamOptions;

	constructor(host: ModelSettingsHost, options: ModelSettingsOptions) {
		this.host = host;
		this.options = structuredClone(options.streamOptions ?? {});
		this.scoped = options.scopedModels ?? [];
		if (options.model) this.selectedModels.set(modelKey(options.model.provider, options.model.id), options.model);
	}

	/** The provider options the conversation reads for every request. */
	get streamOptions(): ConversationStreamOptions {
		return this.options;
	}

	private setStreamOptions(options: ConversationStreamOptions): void {
		this.options = structuredClone(options);
		this.host.conversation().setStreamOptions(this.options);
	}

	setTransport(transport: NonNullable<ConversationStreamOptions["transport"]>): void {
		this.host.assertActive();
		this.setStreamOptions({ ...this.options, transport });
	}

	/**
	 * Commit the configured model and thinking level when the branch names
	 * others, before the conversation opens: a model whose provider has no
	 * credentials is still the session's selection.
	 */
	async applyInitialSelection(model: Model<Api> | undefined, thinkingLevel: ThinkingLevel | undefined): Promise<void> {
		const context = this.host.sessionManager.getConversationState().context;
		if (model && (context.model?.provider !== model.provider || context.model.modelId !== model.id)) {
			await this.host.sessionManager.logWriter.appendModelChange(model.provider, model.id);
		}
		if (thinkingLevel !== undefined && thinkingLevel !== context.thinkingLevel) {
			await this.host.sessionManager.logWriter.appendThinkingLevelChange(thinkingLevel);
		}
	}

	/** The model the active branch names (may be undefined if none is selected or it is not known) */
	get model(): Model<Api> | undefined {
		const ref = this.host.conversation().state.context.model;
		return ref ? this.findModel(ref.provider, ref.modelId) : undefined;
	}

	/**
	 * A model the log names: the object last selected for it, the registry's,
	 * or a scoped model the registry does not list. Turns and summaries run
	 * with it; prompts check its credentials first.
	 */
	findModel(provider: string, modelId: string): Model<Api> | undefined {
		return (
			this.selectedModels.get(modelKey(provider, modelId)) ??
			this.host.modelRegistry.find(provider, modelId) ??
			this.scoped.find((scoped) => scoped.model.provider === provider && scoped.model.id === modelId)?.model
		);
	}

	/** The active branch's thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.host.conversation().state.context.thinkingLevel;
	}

	/** Whether the branch-local Fast mode policy is enabled. */
	get fastModeEnabled(): boolean {
		return this.host.conversation().state.context.fastMode;
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
		return this.scoped;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void {
		this.host.assertActive();
		this.scoped = scopedModels;
	}

	async emitModelSelect(
		nextModel: Model<Api>,
		previousModel: Model<Api> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		this.host.assertActive();
		if (modelsAreEqual(previousModel, nextModel)) return;
		this.host.publishPromptCacheStatus();
		await this.host.extensionRunner().emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session, and persists as the default unless disabled.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<Api>, options?: ModelSelectOptions): Promise<void> {
		this.host.assertActive();
		if (!this.host.modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		const previousModel = this.model;
		const previousThinkingLevel = this.thinkingLevel;
		const persistDefault = options?.persistDefault !== false;
		const thinkingLevel = this.thinkingLevelForModelSwitch(model);
		await this.commitModelAndThinkingLevel(model, thinkingLevel);
		this.host.assertActive();
		this.host.syncPlanningRuntime();
		if (persistDefault) {
			this.host.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			if (this.supportsThinking() || thinkingLevel !== "off") {
				this.host.settingsManager.setDefaultThinkingLevel(thinkingLevel);
			}
		}
		this.publishThinkingLevelChange(thinkingLevel, previousThinkingLevel);
		await this.host.settingsManager.flush();
		this.host.assertActive();

		await this.emitModelSelect(model, previousModel, options?.source ?? "set");
	}

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes. Settings persistence can be disabled.
	 */
	async setThinkingLevel(level: ThinkingLevel, options?: DefaultPersistenceOptions): Promise<void> {
		this.host.assertActive();
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level, availableLevels);
		const previousLevel = this.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;
		const persistDefault = options?.persistDefault !== false;

		if (!isChanging) {
			return;
		}

		await this.host.conversation().setThinkingLevel(effectiveLevel);
		this.host.assertActive();

		if (persistDefault && (this.supportsThinking() || effectiveLevel !== "off")) {
			this.host.settingsManager.setDefaultThinkingLevel(effectiveLevel);
		}
		this.publishThinkingLevelChange(effectiveLevel, previousLevel);
	}

	/** Commit a model selection and the thinking level it runs with; both come from the log. */
	private async commitModelAndThinkingLevel(model: Model<Api>, thinkingLevel: ThinkingLevel): Promise<void> {
		this.selectedModels.set(modelKey(model.provider, model.id), model);
		await this.host.conversation().setModel(model);
		await this.host.conversation().setThinkingLevel(thinkingLevel);
	}

	private publishThinkingLevelChange(effectiveLevel: ThinkingLevel, previousLevel: ThinkingLevel): void {
		if (effectiveLevel === previousLevel) return;
		this.host.emit({ type: "thinking_level_changed", level: effectiveLevel });
		void this.host.extensionRunner().emit({
			type: "thinking_level_select",
			level: effectiveLevel,
			previousLevel,
		});
		// The next request uses a different thinking configuration, so keepalive no longer applies.
		this.host.publishPromptCacheStatus();
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.model;
		if (!model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	/** Commit a branch-local Fast mode transition before publishing its settled state. */
	async setFastModeEnabled(enabled: boolean): Promise<void> {
		this.host.assertActive();
		if (enabled === this.fastModeEnabled) {
			return;
		}

		await this.host.conversation().setFastMode(enabled);
		this.host.assertActive();
		this.emitFastModeStateChanged();
	}

	private thinkingLevelForModelSwitch(model: Model<Api>, explicitLevel?: ThinkingLevel): ThinkingLevel {
		const desiredLevel =
			explicitLevel ??
			(this.supportsThinking()
				? this.thinkingLevel
				: (this.host.settingsManager.getDefaultThinkingLevel() ?? "medium"));
		return clampThinkingLevel(model, desiredLevel) as ThinkingLevel;
	}

	emitFastModeStateChanged(): void {
		this.host.emit({ type: "fast_mode_changed", enabled: this.fastModeEnabled });
	}

	private clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		const model = this.model;
		return model ? (clampThinkingLevel(model, level) as ThinkingLevel) : "off";
	}

	/** Apply the queue modes and provider options the settings name (after a settings reload). */
	syncFromSettings(): void {
		this.host.conversation().setQueueModes({
			steer: this.host.settingsManager.getSteeringMode(),
			followUp: this.host.settingsManager.getFollowUpMode(),
		});
		const transport = this.host.settingsManager.getTransport();
		const { cacheRetention: _previousRetention, ...options } = this.options;
		this.setStreamOptions({
			...options,
			...(this.host.settingsManager.getPromptCacheRetention() === "long" ? { cacheRetention: "long" } : {}),
			...(transport === undefined ? {} : { transport }),
			thinkingBudgets: this.host.settingsManager.getThinkingBudgets(),
			maxRetryDelayMs: this.host.settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		});
		// A changed retention changes when the cached prefix expires.
		this.host.publishPromptCacheStatus();
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.host.conversation().queueModes.steer;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.host.conversation().queueModes.followUp;
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.host.assertActive();
		this.host.conversation().setQueueModes({ steer: mode });
		this.host.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.host.assertActive();
		this.host.conversation().setQueueModes({ followUp: mode });
		this.host.settingsManager.setFollowUpMode(mode);
	}

	/**
	 * Keep the branch's model current with the registry: when it left the
	 * registry (its provider was unregistered or reloaded away), a fallback is
	 * selected and committed as a model change.
	 */
	async refreshFromRegistry(): Promise<void> {
		const ref = this.host.conversation().state.context.model;
		const registered = ref ? this.host.modelRegistry.find(ref.provider, ref.modelId) : undefined;
		if (!ref || registered) {
			// A provider change replaces the selected model with the registry's current definition.
			if (ref && registered) this.selectedModels.set(modelKey(ref.provider, ref.modelId), registered);
			this.host.syncPlanningRuntime();
			return;
		}

		const scopedFallback = this.scoped
			.map((scoped) => this.host.modelRegistry.find(scoped.model.provider, scoped.model.id))
			.find((model) => model !== undefined && this.host.modelRegistry.hasConfiguredAuth(model));
		const fallbackModel = scopedFallback ?? this.host.modelRegistry.getAvailable()[0];
		if (!fallbackModel) {
			this.host.syncPlanningRuntime();
			return;
		}

		const thinkingLevel = this.thinkingLevelForModelSwitch(fallbackModel);
		const previousThinkingLevel = this.thinkingLevel;
		await this.commitModelAndThinkingLevel(fallbackModel, thinkingLevel);
		this.host.syncPlanningRuntime();
		this.publishThinkingLevelChange(thinkingLevel, previousThinkingLevel);
	}
}
