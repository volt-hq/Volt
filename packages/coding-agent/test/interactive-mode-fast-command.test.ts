import type { Api, Model } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { HostActionInvocationContext, HostActionSessionState } from "../src/core/host-actions.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type FastCommandHarness = {
	session: HostActionSessionState;
	createHostActionContext(): HostActionInvocationContext;
	showStatus(message: string): void;
	showWarning(message: string): void;
};

const handleFastCommand = Reflect.get(InteractiveMode.prototype, "handleFastCommand") as (
	this: FastCommandHarness,
	text: string,
) => Promise<void>;

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: {
		isInitialized: boolean;
		footer: { invalidate(): void };
		ui: { requestRender(): void };
	},
	event: AgentSessionEvent,
) => Promise<void>;

function createModel(): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

function createHarness(options: { busy?: boolean; fastModeEnabled?: boolean; model?: Model<Api> } = {}) {
	let fastModeEnabled = options.fastModeEnabled ?? false;
	const setFastModeEnabled = vi.fn((enabled: boolean) => {
		fastModeEnabled = enabled;
	});
	const session: HostActionSessionState = {
		isBusy: options.busy ?? false,
		isStreaming: false,
		isCompacting: false,
		model: options.model ?? createModel(),
		thinkingLevel: "high",
		get fastModeEnabled() {
			return fastModeEnabled;
		},
	};
	const showStatus = vi.fn<(message: string) => void>();
	const showWarning = vi.fn<(message: string) => void>();
	const context = {
		session,
		abortRun: vi.fn(async () => {}),
		compactContext: vi.fn(async () => ({ summary: "", firstKeptEntryId: "entry", tokensBefore: 0 })),
		newSession: vi.fn(async () => ({ cancelled: true, seeded: false })),
		renameSession: vi.fn(() => {}),
		setFastModeEnabled,
	} as HostActionInvocationContext;
	const harness: FastCommandHarness = {
		session,
		createHostActionContext: () => context,
		showStatus,
		showWarning,
	};

	return { harness, session, setFastModeEnabled, showStatus, showWarning };
}

describe("InteractiveMode /fast command", () => {
	it("toggles with no argument and preserves thinking", async () => {
		const { harness, session, setFastModeEnabled, showStatus, showWarning } = createHarness();

		await handleFastCommand.call(harness, "/fast");
		expect(session.fastModeEnabled).toBe(true);
		expect(session.thinkingLevel).toBe("high");
		expect(showWarning).toHaveBeenLastCalledWith("Fast mode enabled. Priority processing may cost more.");

		await handleFastCommand.call(harness, "/fast");
		expect(session.fastModeEnabled).toBe(false);
		expect(session.thinkingLevel).toBe("high");
		expect(showStatus).toHaveBeenLastCalledWith("Fast mode disabled");
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [false]]);
	});

	it("supports exact, idempotent on and off arguments", async () => {
		const { harness, setFastModeEnabled, showStatus, showWarning } = createHarness();

		await handleFastCommand.call(harness, "/fast on");
		await handleFastCommand.call(harness, "/fast on");
		expect(showWarning).toHaveBeenLastCalledWith("Fast mode already enabled. Priority processing may cost more.");

		await handleFastCommand.call(harness, "/fast off");
		await handleFastCommand.call(harness, "/fast off");
		expect(showStatus).toHaveBeenLastCalledWith("Fast mode already disabled");
		expect(setFastModeEnabled.mock.calls).toEqual([[true], [true], [false], [false]]);
	});

	it.each(["/fast toggle", "/fast ON", "/fast on extra"])("rejects invalid syntax: %s", async (command) => {
		const { harness, setFastModeEnabled, showWarning } = createHarness();

		await handleFastCommand.call(harness, command);

		expect(showWarning).toHaveBeenCalledWith("Usage: /fast [on|off]");
		expect(setFastModeEnabled).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "busy session",
			options: { busy: true },
			reason: "Fast mode is not available while an agent operation is running",
		},
		{
			name: "unsupported model",
			options: { model: { ...createModel(), provider: "anthropic", api: "anthropic-messages" as const } },
			reason: "Fast mode is not supported for the current provider and model",
		},
	])("shows the host reason for a $name", async ({ options, reason }) => {
		const { harness, setFastModeEnabled, showWarning } = createHarness(options);

		await handleFastCommand.call(harness, "/fast on");

		expect(showWarning).toHaveBeenCalledWith(reason);
		expect(setFastModeEnabled).not.toHaveBeenCalled();
	});

	it("allows Fast mode to be disabled for an unsupported model", async () => {
		const { harness, session, setFastModeEnabled, showStatus } = createHarness({
			fastModeEnabled: true,
			model: { ...createModel(), provider: "anthropic", api: "anthropic-messages" },
		});

		await handleFastCommand.call(harness, "/fast off");

		expect(session.fastModeEnabled).toBe(false);
		expect(showStatus).toHaveBeenCalledWith("Fast mode disabled");
		expect(setFastModeEnabled).toHaveBeenCalledWith(false);
	});

	it("invalidates and repaints the footer for Fast mode state events", async () => {
		const invalidate = vi.fn();
		const requestRender = vi.fn();

		await handleEvent.call(
			{ isInitialized: true, footer: { invalidate }, ui: { requestRender } },
			{
				type: "ui_action_state_changed",
				action: "thinking.fast_mode",
				state: { type: "boolean", value: true, label: "Fast mode enabled" },
			},
		);

		expect(invalidate).toHaveBeenCalledOnce();
		expect(requestRender).toHaveBeenCalledOnce();
	});
});
