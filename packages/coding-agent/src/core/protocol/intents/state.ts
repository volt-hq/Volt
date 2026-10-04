/**
 * Intent state: what availability and descriptor state read from the target
 * conversation, and the descriptor states clients render. Pure functions of
 * the view, so legacy event emitters read them without the definitions.
 */

import type { AgentSession } from "../../agent-session.ts";
import type { UiActionStateDescriptor } from "../../rpc/types.ts";
import { IDLE_INTENT_STATE, type IntentState, type IntentView } from "./types.ts";

/** The state intent availability reads, from the target session; idle for host-scope invocations. */
export function intentStateOf(session: AgentSession | undefined): IntentState {
	if (!session) return IDLE_INTENT_STATE;
	return {
		isReviewDiscussion: session.isReviewDiscussion,
		isBusy: session.isBusy,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		hasBackgroundJobs: session.hasBackgroundJobs,
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		fastModeEnabled: session.fastModeEnabled,
		planningState: session.planningState,
		settingsManager: session.settingsManager,
	};
}

/** Whether the session holds a turn; hosts without `isBusy` fall back to streaming. */
export function isIntentStateBusy(state: IntentState): boolean {
	return state.isBusy ?? state.isStreaming;
}

export function fastModeState(view: IntentView): UiActionStateDescriptor {
	const enabled = view.state.fastModeEnabled === true;
	return { type: "boolean", value: enabled, label: enabled ? "Fast mode enabled" : "Fast mode disabled" };
}

export function agentModeState(view: IntentView): UiActionStateDescriptor {
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

export function autoCompactionState(view: IntentView): UiActionStateDescriptor {
	const value = view.state.settingsManager?.getCompactionEnabled() ?? true;
	return { type: "boolean", value, label: value ? "Auto-compaction enabled" : "Auto-compaction disabled" };
}

export function compactionThresholdState(view: IntentView): UiActionStateDescriptor {
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
