/**
 * Intent state: what availability and descriptor state read from the target
 * conversation, and the descriptor states clients render. Pure functions of
 * the view, so the live feed reads them without the definitions.
 */

import { supportsFastInference } from "@hansjm10/volt-ai";
import {
	AMBIGUOUS_CLIENT_INPUT_PREVIEW_MAX_CHARS,
	type IntentAvailability as IntentAvailabilityValue,
	type IntentStateValue,
} from "@hansjm10/volt-protocol";
import type { AgentSession } from "../../agent-session.ts";
import type { AmbiguousClientInput } from "../../session/client-inputs.ts";
import {
	IDLE_INTENT_STATE,
	INTENT_ENABLED,
	type IntentAvailability,
	type IntentState,
	type IntentView,
	LOCAL_INTENT_PROFILE,
} from "./types.ts";

/** The state intent availability reads, from the target session; idle for host-scope invocations. */
export function intentStateOf(session: AgentSession | undefined): IntentState {
	if (!session) return IDLE_INTENT_STATE;
	return {
		isReviewDiscussion: session.isReviewDiscussion,
		isBusy: session.isBusy,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		fastModeEnabled: session.fastModeEnabled,
		planningState: session.planningState,
		settingsManager: session.settingsManager,
		ambiguousInput: session.ambiguousClientInput,
	};
}

/** Whether the session holds a turn; hosts without `isBusy` fall back to streaming. */
export function isIntentStateBusy(state: IntentState): boolean {
	return state.isBusy ?? state.isStreaming;
}

export function fastModeState(view: IntentView): IntentStateValue {
	const enabled = view.state.fastModeEnabled === true;
	return { type: "boolean", value: enabled, label: enabled ? "Fast mode enabled" : "Fast mode disabled" };
}

export function agentModeState(view: IntentView): IntentStateValue {
	const mode = view.state.planningState?.mode ?? "build";
	return {
		type: "enum",
		value: mode,
		label: mode === "plan" ? "Plan" : "Build",
		options: [
			{ value: "build", label: "Build" },
			{ value: "plan", label: "Plan" },
		],
	};
}

export function autoCompactionState(view: IntentView): IntentStateValue {
	const value = view.state.settingsManager?.getCompactionEnabled() ?? true;
	return { type: "boolean", value, label: value ? "Auto-compaction enabled" : "Auto-compaction disabled" };
}

export function compactionThresholdState(view: IntentView): IntentStateValue {
	const { model, settingsManager } = view.state;
	const value = model ? (settingsManager?.getCompactionThresholdTokens(`${model.provider}/${model.id}`) ?? 0) : 0;
	const presets = [...new Set([0, 100_000, 150_000, 200_000, 250_000, 350_000, 500_000, 750_000, value])].sort(
		(a, b) => a - b,
	);
	return {
		type: "integer",
		value,
		label: value === 0 ? "Default" : `${value.toLocaleString("en-US")} tokens`,
		options: presets.map((tokens) => ({
			value: String(tokens),
			label: tokens === 0 ? "Default" : `${tokens.toLocaleString("en-US")} tokens`,
		})),
	};
}

export function fastModeAvailability(view: IntentView, input?: { enabled: boolean }): IntentAvailability {
	const { state } = view;
	if (state.isStreaming) {
		return { enabled: false, reason: "Fast mode is not available while the agent is streaming" };
	}
	if (isIntentStateBusy(state)) {
		return { enabled: false, reason: "Fast mode is not available while an agent operation is running" };
	}
	if (state.isCompacting) {
		return { enabled: false, reason: "Fast mode is not available while compaction is running" };
	}
	if (state.fastModeEnabled === true || input?.enabled === false) return INTENT_ENABLED;
	if (!state.model || !supportsFastInference(state.model)) {
		return { enabled: false, reason: "Fast mode is not supported for the current provider and model" };
	}
	return INTENT_ENABLED;
}

/** An ambiguous input as clients see it: its id and the start of its text, never splitting a character. */
export function ambiguousInputPreview(input: AmbiguousClientInput): { clientMessageId: string; preview: string } {
	let preview = input.message;
	if (preview.length > AMBIGUOUS_CLIENT_INPUT_PREVIEW_MAX_CHARS) {
		let end = AMBIGUOUS_CLIENT_INPUT_PREVIEW_MAX_CHARS - 1;
		const last = preview.charCodeAt(end - 1);
		if (last >= 0xd800 && last <= 0xdbff) end--;
		preview = `${preview.slice(0, end)}…`;
	}
	return { clientMessageId: input.clientMessageId, preview };
}

/** The ambiguous input `discard_client_input` resolves: its client message id, labeled with its preview. */
export function ambiguousInputState(view: IntentView): IntentStateValue {
	const input = view.state.ambiguousInput;
	if (input === undefined) return { type: "string", value: null };
	const { clientMessageId, preview } = ambiguousInputPreview(input);
	return { type: "string", value: clientMessageId, label: preview };
}

/**
 * `discard_client_input` waits for the conversation to be idle, so the queued
 * input behind the discarded one can replay; without input (a descriptor), it
 * is enabled only while an ambiguous input holds later input back.
 */
export function ambiguousInputAvailability(view: IntentView, input?: { clientMessageId: string }): IntentAvailability {
	if (isIntentStateBusy(view.state)) {
		return { enabled: false, reason: "Wait for the agent to finish before discarding a stuck message" };
	}
	if (input === undefined && view.state.ambiguousInput === undefined) {
		return { enabled: false, reason: "No message is stuck" };
	}
	return INTENT_ENABLED;
}

export type CompactionField = "enabled" | "modelThresholds";

export function compactionSaveScope(view: IntentView): string {
	const profile = view.state.settingsManager?.getActiveProfile();
	return profile ? `in global profile "${profile}" on the connected host` : "globally on the connected host";
}

export function compactionSettingsAvailability(view: IntentView, field: CompactionField): IntentAvailability {
	const { state } = view;
	if (state.isStreaming) return { enabled: false, reason: "Compaction settings are unavailable while streaming" };
	if (isIntentStateBusy(state)) {
		return { enabled: false, reason: "Compaction settings are unavailable while an agent operation is running" };
	}
	if (state.isCompacting) return { enabled: false, reason: "Compaction settings are unavailable while compacting" };
	const { model, settingsManager } = state;
	if (!model) return { enabled: false, reason: "Select a model to configure compaction" };
	if (!settingsManager) return { enabled: false, reason: "Compaction settings are unavailable in this host" };
	const reason = settingsManager.getCompactionWriteDisabledReason(field, `${model.provider}/${model.id}`);
	return reason ? { enabled: false, reason } : INTENT_ENABLED;
}

function liveAvailability(
	name: string,
	availability: IntentAvailability,
	state: IntentStateValue,
): IntentAvailabilityValue {
	return {
		name,
		enabled: availability.enabled,
		...(availability.enabled ? {} : { reason: availability.reason }),
		state,
	};
}

/**
 * The intents whose availability and state follow the conversation (the
 * built-in intents with a state), as the live `intents` value carries them.
 * Pure functions of the session, so the live state reads them without the
 * registry.
 */
export function liveIntentAvailability(session: AgentSession): IntentAvailabilityValue[] {
	const view: IntentView = { state: intentStateOf(session), services: {}, profile: LOCAL_INTENT_PROFILE };
	return [
		liveAvailability("set_fast_mode", fastModeAvailability(view), fastModeState(view)),
		liveAvailability("set_agent_mode", INTENT_ENABLED, agentModeState(view)),
		liveAvailability(
			"set_auto_compaction",
			compactionSettingsAvailability(view, "enabled"),
			autoCompactionState(view),
		),
		liveAvailability(
			"set_compaction_threshold",
			compactionSettingsAvailability(view, "modelThresholds"),
			compactionThresholdState(view),
		),
		liveAvailability("discard_client_input", ambiguousInputAvailability(view), ambiguousInputState(view)),
	];
}

/** How a fast mode change reads to the user: what changed, and that priority processing may cost more. */
export function describeFastModeChange(outcome: { requested: boolean; wasEnabled: boolean; enabled: boolean }): string {
	const changed = outcome.wasEnabled !== outcome.enabled;
	if (outcome.requested) {
		return changed
			? "Fast mode enabled. Priority processing may cost more."
			: "Fast mode already enabled. Priority processing may cost more.";
	}
	return changed ? "Fast mode disabled" : "Fast mode already disabled";
}
