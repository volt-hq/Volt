import type { RpcPromptCacheStatus } from "@hansjm10/volt-protocol";
import { visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import { withTransientUsage } from "../src/modes/interactive/client/footer-model.ts";
import {
	FooterComponent,
	type FooterViewModel,
	formatCwdForFooter,
} from "../src/modes/interactive/components/footer.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

/** A footer view model as the TUI's store and catalogs would give it. */
function viewModel(options: {
	sessionName: string;
	modelId?: string;
	provider?: string;
	reasoning?: boolean;
	thinkingLevel?: string;
	fastModeEnabled?: boolean;
	usage?: AssistantUsage;
	usingSubscription?: boolean;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
	contextWarningTokens?: number;
	promptCache?: RpcPromptCacheStatus;
	providerCount?: number;
}): FooterViewModel {
	const usage = options.usage;
	const contextWindow = options.contextWindow ?? 200_000;
	const contextTokens = options.contextTokens === undefined ? 24_600 : options.contextTokens;
	const prompt = usage === undefined ? 0 : usage.input + usage.cacheRead + usage.cacheWrite;
	return {
		cwd: "/tmp/project",
		gitBranch: "main",
		sessionName: options.sessionName || null,
		model: {
			id: options.modelId ?? "test-model",
			provider: options.provider ?? "test",
			contextWindow,
			reasoning: options.reasoning ?? false,
		},
		thinkingLevel: options.thinkingLevel ?? "off",
		fastMode: options.fastModeEnabled ?? false,
		availableProviderCount: options.providerCount ?? 1,
		usingSubscription: options.usingSubscription ?? false,
		autoCompact: true,
		contextWarningTokens: options.contextWarningTokens ?? 350_000,
		usage: {
			input: usage?.input ?? 0,
			output: usage?.output ?? 0,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			cost: usage?.cost.total ?? 0,
			...(prompt > 0 && usage ? { latestCacheHitRate: (usage.cacheRead / prompt) * 100 } : {}),
			contextUsage: {
				tokens: contextTokens,
				contextWindow,
				percent: options.contextPercent === undefined ? 12.3 : options.contextPercent,
			},
		},
		promptCache: options.promptCache,
		statuses: new Map(),
	};
}

function footerOf(model: FooterViewModel, requestRender?: () => void): FooterComponent {
	return new FooterComponent(() => model, requestRender);
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("FooterComponent width handling", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	it("keeps all lines within width for wide session names", () => {
		const width = 93;
		const session = viewModel({ sessionName: "한글".repeat(30) });
		const footer = footerOf({ ...session, availableProviderCount: 1 });

		const lines = footer.render(width).lines;
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("keeps stats line within width for wide model and provider names", () => {
		const width = 60;
		const session = viewModel({
			sessionName: "",
			modelId: "模".repeat(30),
			provider: "공급자",
			reasoning: true,
			thinkingLevel: "high",
			usage: {
				input: 12_345,
				output: 6_789,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 1.234 },
			},
		});
		const footer = footerOf({ ...session, availableProviderCount: 2 });

		const lines = footer.render(width).lines;
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it.each([80, 120, 160])("shows Fast mode alongside thinking at width %s", (width) => {
		const footer = footerOf(
			viewModel({
				sessionName: "",
				modelId: "gpt-5.4",
				provider: "openai",
				reasoning: true,
				thinkingLevel: "high",
				fastModeEnabled: true,
				providerCount: 2,
			}),
		);

		const workspaceLine = stripAnsi(footer.render(width).lines[0]);
		expect(workspaceLine).toContain("fast · high");
		expect(visibleWidth(workspaceLine)).toBeLessThanOrEqual(width);
	});

	it("preserves Fast mode and thinking when a long model name is truncated", () => {
		const width = 40;
		const footer = footerOf(
			viewModel({
				sessionName: "",
				modelId: "gpt-5.4-very-long-model-name-that-needs-truncation",
				reasoning: true,
				thinkingLevel: "high",
				fastModeEnabled: true,
				providerCount: 2,
			}),
		);

		const workspaceLine = stripAnsi(footer.render(width).lines[0]);
		expect(workspaceLine).toContain("fast · high");
		expect(visibleWidth(workspaceLine)).toBeLessThanOrEqual(width);
	});

	it.each([11, 12, 13])("keeps the Fast suffix within a narrow width of %s", (width) => {
		const footer = footerOf(
			viewModel({
				sessionName: "",
				modelId: "gpt-5.4",
				reasoning: true,
				thinkingLevel: "high",
				fastModeEnabled: true,
			}),
		);

		const workspaceLine = stripAnsi(footer.render(width).lines[0]);
		expect(workspaceLine).toContain("fast · high");
		expect(visibleWidth(workspaceLine)).toBeLessThanOrEqual(width);
	});

	it("does not show the Fast marker when Fast mode is disabled", () => {
		const footer = footerOf(
			viewModel({
				sessionName: "",
				reasoning: true,
				thinkingLevel: "high",
			}),
		);

		expect(stripAnsi(footer.render(120).lines[0])).not.toContain("fast");
	});

	it.each(["off", "low", "high"])("keeps the Fast marker independent of thinking level %s", (thinkingLevel) => {
		const footer = footerOf(
			viewModel({
				sessionName: "",
				reasoning: true,
				thinkingLevel,
				fastModeEnabled: true,
			}),
		);

		const workspaceLine = stripAnsi(footer.render(120).lines[0]);
		expect(workspaceLine).toContain(`fast · ${thinkingLevel}`);
	});

	it("labels subscription billing without showing a misleading zero cost", () => {
		const footer = footerOf(viewModel({ sessionName: "", usingSubscription: true }));

		const statsLine = stripAnsi(footer.render(120).lines[1]);
		expect(statsLine).toContain("subscription");
		expect(statsLine).not.toContain("$0.000");
	});

	it("shows the latest cache hit rate when cache usage is present", () => {
		const session = viewModel({
			sessionName: "",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 50,
				cacheWrite: 50,
				cost: { total: 0.001 },
			},
		});
		const footer = footerOf({ ...session, availableProviderCount: 1 });

		const statsLine = stripAnsi(footer.render(120).lines[1]);
		expect(statsLine).toContain("CH25.0%");
	});

	it("shows transient isolated-workflow usage without changing the workspace session", () => {
		const session = viewModel({
			sessionName: "parent-session",
			modelId: "parent-model",
			reasoning: true,
			thinkingLevel: "low",
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { total: 0.1 },
			},
		});
		let transient: Parameters<typeof withTransientUsage>[1] = {
			model: {
				id: "review-model",
				name: "review-model",
				provider: "test",
				api: "openai-completions",
				baseUrl: "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
			thinkingLevel: "high",
			fastModeEnabled: true,
			contextUsage: { tokens: 75_000, contextWindow: 100_000, percent: 75 },
			totals: { input: 300, output: 30, cacheRead: 150, cacheWrite: 0, cost: 0.3 },
			latestCacheHitRate: 50,
		};
		const footer = new FooterComponent(() => withTransientUsage(session, transient));

		const workflowLines = footer.render(120).lines.map(stripAnsi);
		expect(workflowLines[0]).toContain("project · main · parent-session");
		expect(workflowLines[0]).toContain("review-model · fast · high");
		expect(workflowLines[1]).toContain("context 75.0%/100k auto");
		expect(workflowLines[1]).toContain("$0.300");
		expect(workflowLines[1]).toContain("CH50.0%");

		transient = undefined;
		const restoredLines = footer.render(120).lines.map(stripAnsi);
		expect(restoredLines[0]).toContain("parent-model · low");
		expect(restoredLines[1]).toContain("context 12.3%/200k auto");
		expect(restoredLines[1]).toContain("$0.100");
	});

	describe("prompt cache status", () => {
		const now = Date.UTC(2026, 8, 23, 15, 0, 0);

		afterEach(() => {
			vi.useRealTimers();
		});

		function renderStats(footer: FooterComponent): string {
			return stripAnsi(footer.render(160).lines[1]);
		}

		it("counts down the documented retention window", () => {
			vi.useFakeTimers({ now });
			const footer = footerOf(
				viewModel({
					sessionName: "",
					promptCache: { kind: "retained", lastRequestAt: now - 1_000, expiresAt: now + 299_000 },
				}),
			);

			expect(renderStats(footer)).toContain("cache 5m");
			vi.setSystemTime(now + 60_000);
			expect(renderStats(footer)).toContain("cache 4m");
			vi.setSystemTime(now + 299_000);
			expect(renderStats(footer)).toContain("cache expired");
		});

		it("shows the idle keepalive window, then the expiry countdown", () => {
			vi.useFakeTimers({ now });
			const footer = footerOf(
				viewModel({
					sessionName: "",
					promptCache: {
						kind: "retained",
						lastRequestAt: now,
						expiresAt: now + 300_000,
						keepAliveUntil: now + 720_000,
					},
				}),
			);

			expect(renderStats(footer)).toContain("cache warm 12m");
			vi.setSystemTime(now + 240_000);
			expect(renderStats(footer)).toContain("cache warm 8m");
			vi.setSystemTime(now + 720_000);
			expect(renderStats(footer)).toContain("cache expired");
		});

		it("shows hours for long retention windows", () => {
			vi.useFakeTimers({ now });
			const footer = footerOf(
				viewModel({
					sessionName: "",
					promptCache: { kind: "retained", lastRequestAt: now, expiresAt: now + 86_400_000 },
				}),
			);

			expect(renderStats(footer)).toContain("cache 24h");
		});

		it("marks a cold cache after a model change", () => {
			const footer = footerOf(viewModel({ sessionName: "", promptCache: { kind: "model_changed" } }));

			expect(footer.render(160).lines[1]).toContain(theme.fg("warning", "cache cold"));
		});

		it("omits the status without a published window or while showing workflow usage", () => {
			vi.useFakeTimers({ now });
			const unknown = footerOf(
				viewModel({ sessionName: "", promptCache: { kind: "retained", lastRequestAt: now } }),
			);
			expect(renderStats(unknown)).not.toContain("cache");

			const session = viewModel({
				sessionName: "",
				promptCache: { kind: "retained", lastRequestAt: now, expiresAt: now + 300_000 },
			});
			const workflow = session.model;
			if (workflow === undefined) throw new Error("The view model names no model");
			const transient = footerOf(
				withTransientUsage(session, {
					model: {
						id: workflow.id,
						name: workflow.id,
						provider: workflow.provider,
						api: "openai-completions",
						baseUrl: "",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: workflow.contextWindow,
						maxTokens: 1_000,
					},
					thinkingLevel: "off",
					fastModeEnabled: false,
					contextUsage: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 },
					totals: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
					latestCacheHitRate: undefined,
				}),
			);
			expect(renderStats(transient)).not.toContain("cache");
		});

		it("requests a render when the countdown changes while idle", () => {
			vi.useFakeTimers({ now });
			const requestRender = vi.fn();
			const footer = footerOf(
				viewModel({
					sessionName: "",
					promptCache: { kind: "retained", lastRequestAt: now - 1_000, expiresAt: now + 61_000 },
				}),
				requestRender,
			);

			expect(renderStats(footer)).toContain("cache 2m");
			footer.render(160);
			vi.advanceTimersByTime(999);
			expect(requestRender).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(requestRender).toHaveBeenCalledTimes(1);

			expect(renderStats(footer)).toContain("cache 1m");
			vi.advanceTimersByTime(60_000);
			expect(requestRender).toHaveBeenCalledTimes(2);
			expect(renderStats(footer)).toContain("cache expired");
			vi.advanceTimersByTime(600_000);
			expect(requestRender).toHaveBeenCalledTimes(2);

			footer.dispose();
		});
	});

	it("warns at the configured absolute context threshold", () => {
		const warningFooter = footerOf(
			viewModel({
				sessionName: "",
				contextTokens: 350_000,
				contextWindow: 1_000_000,
				contextPercent: 35,
				contextWarningTokens: 350_000,
			}),
		);
		const mutedFooter = footerOf(
			viewModel({
				sessionName: "",
				contextTokens: 350_000,
				contextWindow: 1_000_000,
				contextPercent: 35,
				contextWarningTokens: 400_000,
			}),
		);

		expect(warningFooter.render(120).lines[1]).toContain(theme.fg("warning", "35.0%/1.0M auto"));
		expect(mutedFooter.render(120).lines[1]).toContain(theme.fg("muted", "35.0%/1.0M auto"));
	});
});
