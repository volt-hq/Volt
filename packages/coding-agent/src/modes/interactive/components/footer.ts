import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { RpcPromptCacheStatus } from "@hansjm10/volt-protocol";
import { type Component, createRenderFrame, type RenderFrame, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import { theme } from "../../../core/theme/runtime.ts";

/**
 * Sanitize text for display in a single-line status.
 * Removes newlines, tabs, carriage returns, and other control characters.
 */
function sanitizeStatusText(text: string): string {
	// Replace newlines, tabs, carriage returns with space, then collapse multiple spaces
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/**
 * Format token counts for compact footer display.
 */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Countdown unit: hours above one hour remaining, then minutes. */
function promptCacheCountdownUnit(remainingMs: number): number {
	return remainingMs > HOUR_MS ? HOUR_MS : MINUTE_MS;
}

function formatPromptCacheStatus(status: RpcPromptCacheStatus | undefined, now: number): string | undefined {
	if (!status) return undefined;
	if (status.kind === "model_changed") return theme.fg("warning", "cache cold");
	if (status.keepAliveUntil !== undefined && status.keepAliveUntil > now) {
		const keepAlive = status.keepAliveUntil - now;
		const unit = promptCacheCountdownUnit(keepAlive);
		return theme.fg("dim", `cache warm ${Math.ceil(keepAlive / unit)}${unit === HOUR_MS ? "h" : "m"}`);
	}
	if (status.expiresAt === undefined) return undefined;
	const remaining = status.expiresAt - now;
	if (remaining <= 0) return theme.fg("warning", "cache expired");
	const unit = promptCacheCountdownUnit(remaining);
	return theme.fg("dim", `cache ${Math.ceil(remaining / unit)}${unit === HOUR_MS ? "h" : "m"}`);
}

/** Instant the rendered cache countdown next changes, or undefined when it is static. */
function nextPromptCacheChangeAt(status: RpcPromptCacheStatus | undefined, now: number): number | undefined {
	if (status?.kind !== "retained") return undefined;
	if (status.keepAliveUntil !== undefined && status.keepAliveUntil > now) {
		const keepAlive = status.keepAliveUntil - now;
		const unit = promptCacheCountdownUnit(keepAlive);
		return status.keepAliveUntil - (Math.ceil(keepAlive / unit) - 1) * unit;
	}
	if (status.expiresAt === undefined) return undefined;
	const remaining = status.expiresAt - now;
	if (remaining <= 0) return undefined;
	const unit = promptCacheCountdownUnit(remaining);
	return status.expiresAt - (Math.ceil(remaining / unit) - 1) * unit;
}

/** The model the footer names: its provider and id, whether it reasons, and its context window. */
export interface FooterModel {
	readonly provider: string;
	readonly id: string;
	readonly reasoning: boolean;
	readonly contextWindow: number;
}

/** Token use and cost, and the retained context's size. */
export interface FooterUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	/** The share of the latest request's prompt read from the cache, in percent. */
	readonly latestCacheHitRate?: number;
	readonly contextUsage?: {
		readonly tokens: number | null;
		readonly contextWindow: number;
		readonly percent: number | null;
	};
}

/** What the footer shows: the conversation's workspace, model, usage, and status items. */
export interface FooterViewModel {
	/** The conversation's working directory; empty until it is known. */
	readonly cwd: string;
	/** The Git branch, `detached`, or null outside a repository. */
	readonly gitBranch: string | null;
	readonly sessionName: string | null;
	readonly model: FooterModel | undefined;
	readonly thinkingLevel: string;
	readonly fastMode: boolean;
	/** Providers the model selection spans; above one, wide footers name the model's provider. */
	readonly availableProviderCount: number;
	/** The model's requests draw from a subscription login. */
	readonly usingSubscription: boolean;
	readonly autoCompact: boolean;
	/** Context tokens from which the context shows as a warning; 0 never warns. */
	readonly contextWarningTokens: number;
	readonly usage: FooterUsage;
	/** The model's prompt-cache retention; none for usage of another conversation shown in its place. */
	readonly promptCache: RpcPromptCacheStatus | undefined;
	/** Status items by key, shown in key order on one line. */
	readonly statuses: ReadonlyMap<string, string>;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~/${relativeToHome.replace(/\\/g, "/")}`;
}

/**
 * Footer component that shows the workspace, the model, token stats, context
 * usage, and status items: a view of its view model, read at every render.
 */
export class FooterComponent implements Component {
	private readonly model: () => FooterViewModel;
	private readonly requestRender: (() => void) | undefined;
	private cacheRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private cacheRefreshAt: number | undefined;

	/** `requestRender` lets the prompt-cache countdown refresh while the conversation is idle. */
	constructor(model: () => FooterViewModel, requestRender?: () => void) {
		this.model = model;
		this.requestRender = requestRender;
	}

	invalidate(): void {}

	dispose(): void {
		this.clearCacheRefresh();
	}

	private clearCacheRefresh(): void {
		if (this.cacheRefreshTimer) clearTimeout(this.cacheRefreshTimer);
		this.cacheRefreshTimer = undefined;
		this.cacheRefreshAt = undefined;
	}

	private scheduleCacheRefresh(at: number | undefined, now: number): void {
		if (at === this.cacheRefreshAt) return;
		this.clearCacheRefresh();
		const requestRender = this.requestRender;
		if (at === undefined || !requestRender) return;
		this.cacheRefreshAt = at;
		this.cacheRefreshTimer = setTimeout(() => {
			this.cacheRefreshTimer = undefined;
			this.cacheRefreshAt = undefined;
			requestRender();
		}, at - now);
		this.cacheRefreshTimer.unref?.();
	}

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const view = this.model();
		const { usage } = view;
		const activeModel = view.model;
		const fastModeEnabled = view.fastMode;

		const cwd = view.cwd;
		const workspace =
			width < 100
				? basename(resolve(cwd)) || cwd
				: formatCwdForFooter(cwd, process.env.HOME || process.env.USERPROFILE);
		const workspaceParts = [workspace];
		if (view.gitBranch) workspaceParts.push(view.gitBranch);
		if (view.sessionName) workspaceParts.push(view.sessionName);

		const workspaceSide =
			theme.fg("text", workspaceParts[0]!) +
			(workspaceParts.length > 1 ? theme.fg("dim", ` · ${workspaceParts.slice(1).join(" · ")}`) : "");
		const modelName = activeModel?.id || "no-model";
		const provider =
			width >= 100 && view.availableProviderCount > 1 && activeModel
				? theme.fg("dim", `(${activeModel.provider}) `)
				: "";
		const thinking = activeModel?.reasoning ? theme.fg("dim", ` · ${view.thinkingLevel || "off"}`) : "";
		const model = theme.fg("text", modelName);
		const fastLabel = theme.bold(theme.fg("warning", "fast"));
		const fast = fastModeEnabled ? `${theme.fg("dim", " · ")}${fastLabel}` : "";
		let modelSide = `${provider}${model}${fast}${thinking}`;
		if (visibleWidth(modelSide) >= width) {
			const modelWithoutProvider = `${model}${fast}${thinking}`;
			if (visibleWidth(modelWithoutProvider) < width) {
				modelSide = modelWithoutProvider;
			} else if (fastModeEnabled) {
				const fastAndThinking = `${fastLabel}${thinking}`;
				if (visibleWidth(fastAndThinking) > width) {
					modelSide = truncateToWidth(fastLabel, width, "");
				} else {
					const suffix = `${fast}${thinking}`;
					if (visibleWidth(suffix) >= width) {
						modelSide = fastAndThinking;
					} else {
						const modelWidth = width - visibleWidth(suffix);
						modelSide = `${truncateToWidth(model, modelWidth, "")}${suffix}`;
					}
				}
			} else {
				modelSide = truncateToWidth(modelWithoutProvider, width, "");
			}
		}

		const modelWidth = visibleWidth(modelSide);
		const availableWorkspaceWidth = Math.max(0, width - modelWidth - (modelWidth > 0 ? 2 : 0));
		const fittedWorkspace = truncateToWidth(workspaceSide, availableWorkspaceWidth, theme.fg("dim", "…"));
		const workspaceWidth = visibleWidth(fittedWorkspace);
		const workspacePadding = " ".repeat(Math.max(0, width - workspaceWidth - modelWidth));
		const workspaceLine = `${fittedWorkspace}${workspacePadding}${modelSide}`;

		const contextUsage = usage.contextUsage;
		const contextWindow = contextUsage?.contextWindow ?? activeModel?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
		const autoIndicator = view.autoCompact ? " auto" : "";
		const contextDisplay = `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`.replace("?%", "?");
		const contextWarningTokens = view.contextWarningTokens;
		const contextTokens = contextUsage?.tokens;
		const reachedTokenWarning =
			contextWarningTokens > 0 &&
			contextTokens !== undefined &&
			contextTokens !== null &&
			contextTokens >= contextWarningTokens;
		const contextValue =
			contextPercentValue > 90
				? theme.fg("error", contextDisplay)
				: contextPercentValue > 70 || reachedTokenWarning
					? theme.fg("warning", contextDisplay)
					: theme.fg("muted", contextDisplay);

		const detailParts = [`${theme.fg("dim", "context")} ${contextValue}`];
		if (view.usingSubscription) detailParts.push(theme.fg("dim", "subscription"));
		if (usage.cost) detailParts.push(theme.fg("dim", `$${usage.cost.toFixed(3)}`));
		if (usage.input) detailParts.push(theme.fg("dim", `↑${formatTokens(usage.input)}`));
		if (usage.output) detailParts.push(theme.fg("dim", `↓${formatTokens(usage.output)}`));
		if (usage.cacheRead) detailParts.push(theme.fg("dim", `R${formatTokens(usage.cacheRead)}`));
		if (usage.cacheWrite) detailParts.push(theme.fg("dim", `W${formatTokens(usage.cacheWrite)}`));
		if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.latestCacheHitRate !== undefined) {
			detailParts.push(theme.fg("dim", `CH${usage.latestCacheHitRate.toFixed(1)}%`));
		}
		const promptCache = view.promptCache;
		const now = Date.now();
		const promptCacheLabel = formatPromptCacheStatus(promptCache, now);
		if (promptCacheLabel) detailParts.push(promptCacheLabel);
		this.scheduleCacheRefresh(nextPromptCacheChangeAt(promptCache, now), now);
		if (areExperimentalFeaturesEnabled()) {
			detailParts.push(theme.bold(theme.fg("warning", "xp")));
		}
		const detailLine = truncateToWidth(detailParts.join(theme.fg("dim", " · ")), width, theme.fg("dim", "…"));
		const lines = [workspaceLine, detailLine];

		if (view.statuses.size > 0) {
			const sortedStatuses = Array.from(view.statuses.entries())
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([, text]) => sanitizeStatusText(text));
			lines.push(truncateToWidth(sortedStatuses.join(" "), width, theme.fg("dim", "…")));
		}

		return createRenderFrame(lines);
	}
}
